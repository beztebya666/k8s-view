// Package api — Deployment rollout rollback (kubectl rollout undo equivalent).
//
// Background: extensions/v1beta1 Deployments used to expose a `/rollback`
// subresource on the apiserver, but it was removed when Deployments graduated
// to apps/v1 (k/k #49136). The supported way is now what kubectl does
// client-side: pick a target ReplicaSet (by `deployment.kubernetes.io/revision`
// annotation), copy its pod template back into the Deployment's spec, and
// PATCH. The apiserver picks it up, mints a fresh ReplicaSet for the now-
// "current" template, and rolls pods according to the Deployment's strategy.
//
// Two routes:
//
//   GET  /api/v1/{cluster}/rollouts/{namespace}/{name}
//        Revision history: every owned ReplicaSet, sorted by revision desc,
//        with current/template/replica counts. Used by the Rollouts tab.
//
//   POST /api/v1/{cluster}/rollouts/{namespace}/{name}/rollback
//        Body: {"revision": <int>, "changeCause": "<optional string>"}.
//        Resolves the matching RS, strips the auto-injected
//        `pod-template-hash` label from labels (else the controller would
//        mint yet *another* RS for the new hash), and PATCHes the Deployment
//        with a StrategicMergePatch.
//
// Deployment-only on purpose: StatefulSet/DaemonSet revisions live in
// ControllerRevision objects with a different patching shape, and the
// product decision is "Deployment first".

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	appsv1client "k8s.io/client-go/kubernetes/typed/apps/v1"
)

// revisionAnnotation is the Deployment-controller-managed counter that tags
// every ReplicaSet a Deployment has owned. We sort and identify revisions by
// this value, exactly like `kubectl rollout history`.
const revisionAnnotation = "deployment.kubernetes.io/revision"

// changeCauseAnnotation mirrors the historical `kubectl --record` /
// `kubectl annotate` convention. Only set on rollback when the client opts
// in via the request flag — most clusters don't set it and we don't want to
// retroactively pollute a workload's annotations.
const changeCauseAnnotation = "kubernetes.io/change-cause"

// podTemplateHashLabel is injected by the Deployment controller into every
// ReplicaSet's selector/template so the controller can distinguish RS
// instances of the same Deployment. It MUST NOT be carried back into the
// Deployment's template — leaving it would make the controller mint yet
// another RS for the new hash, defeating the rollback.
const podTemplateHashLabel = "pod-template-hash"

type rolloutRevision struct {
	Revision      int64             `json:"revision"`
	ReplicaSet    string            `json:"replicaSet"`
	UID           string            `json:"uid"`
	Created       string            `json:"created"`
	Replicas      int32             `json:"replicas"`
	ReadyReplicas int32             `json:"readyReplicas"`
	Current       bool              `json:"current"`
	Images        []string          `json:"images"`
	ChangeCause   string            `json:"changeCause,omitempty"`
	Template      map[string]any    `json:"template"`
	Labels        map[string]string `json:"labels,omitempty"`
}

type rolloutHistoryResponse struct {
	Deployment      string            `json:"deployment"`
	Namespace       string            `json:"namespace"`
	CurrentRevision int64             `json:"currentRevision"`
	Revisions       []rolloutRevision `json:"revisions"`
}

func (h *handlers) listRollouts(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if ns == "" || name == "" {
		h.writeError(w, r, http.StatusBadRequest, errors.New("namespace and name are required"))
		return
	}

	apps := c.Clientset().AppsV1()
	dep, err := apps.Deployments(ns).Get(r.Context(), name, metav1.GetOptions{})
	if err != nil {
		h.writeError(w, r, statusFor(err), err)
		return
	}
	revs, currentRev, err := collectRevisions(r.Context(), apps, dep)
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, rolloutHistoryResponse{
		Deployment:      name,
		Namespace:       ns,
		CurrentRevision: currentRev,
		Revisions:       revs,
	})
}

type rollbackRequest struct {
	Revision    int64  `json:"revision"`
	ChangeCause string `json:"changeCause"`
}

type rollbackResponse struct {
	RolledBackTo int64  `json:"rolledBackTo"`
	FromRevision int64  `json:"fromRevision"`
	ReplicaSet   string `json:"replicaSet"`
	Deployment   string `json:"deployment"`
	Namespace    string `json:"namespace"`
}

// rollbackDeployment patches the Deployment's pod template to match the
// template recorded on the chosen ReplicaSet. The patch is intentionally
// minimal: only `spec.template` is replaced (with the pod-template-hash
// label stripped from labels), plus an optional change-cause annotation.
// Replicas, strategy and selector stay untouched — they're independent of
// the rollback decision.
func (h *handlers) rollbackDeployment(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if ns == "" || name == "" {
		h.writeError(w, r, http.StatusBadRequest, errors.New("namespace and name are required"))
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	defer r.Body.Close()

	var req rollbackRequest
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, fmt.Errorf("invalid JSON: %w", err))
			return
		}
	}
	if req.Revision <= 0 {
		h.writeError(w, r, http.StatusBadRequest, errors.New("revision must be a positive integer"))
		return
	}

	apps := c.Clientset().AppsV1()
	dep, err := apps.Deployments(ns).Get(r.Context(), name, metav1.GetOptions{})
	if err != nil {
		h.writeError(w, r, statusFor(err), err)
		return
	}
	target, currentRev, err := findRevision(r.Context(), apps, dep, req.Revision)
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	if target == nil {
		h.writeError(w, r, http.StatusNotFound,
			fmt.Errorf("revision %d not found for deployment %s/%s", req.Revision, ns, name))
		return
	}
	if req.Revision == currentRev {
		h.writeError(w, r, http.StatusConflict,
			fmt.Errorf("revision %d is already current — nothing to roll back to", req.Revision))
		return
	}

	template := target.Spec.Template.DeepCopy()
	if template.Labels != nil {
		delete(template.Labels, podTemplateHashLabel)
		if len(template.Labels) == 0 {
			template.Labels = nil
		}
	}

	patch := map[string]any{
		"spec": map[string]any{
			"template": template,
		},
	}
	if req.ChangeCause != "" {
		// Annotation lives on the *Deployment*, not the template, so the
		// existing pods aren't disturbed. Modern (post-1.16) `rollout
		// history` reads it from the Deployment level.
		patch["metadata"] = map[string]any{
			"annotations": map[string]string{
				changeCauseAnnotation: req.ChangeCause,
			},
		}
	}

	patchBytes, err := json.Marshal(patch)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}

	updated, err := apps.Deployments(ns).Patch(
		r.Context(), name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{
			FieldManager: "k8s-view",
		})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}

	writeJSON(w, http.StatusOK, struct {
		Result     rollbackResponse `json:"result"`
		Deployment any              `json:"deployment"`
	}{
		Result: rollbackResponse{
			RolledBackTo: req.Revision,
			FromRevision: currentRev,
			ReplicaSet:   target.Name,
			Deployment:   name,
			Namespace:    ns,
		},
		Deployment: updated,
	})
}

// collectRevisions walks every ReplicaSet in the Deployment's namespace and
// returns the ones owned by `dep`, sorted by revision descending. We filter
// by `ownerReferences[].uid == dep.uid` rather than labels — labels can be
// edited, the owner UID can't.
func collectRevisions(ctx context.Context, apps appsv1client.AppsV1Interface, dep *appsv1.Deployment) ([]rolloutRevision, int64, error) {
	rsList, err := apps.ReplicaSets(dep.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, 0, err
	}
	currentRev, _ := strconv.ParseInt(dep.Annotations[revisionAnnotation], 10, 64)

	out := make([]rolloutRevision, 0, len(rsList.Items))
	for i := range rsList.Items {
		rs := &rsList.Items[i]
		if !ownedBy(rs.OwnerReferences, dep.UID) {
			continue
		}
		rev, _ := strconv.ParseInt(rs.Annotations[revisionAnnotation], 10, 64)
		template, _ := encodeAsMap(rs.Spec.Template)
		out = append(out, rolloutRevision{
			Revision:      rev,
			ReplicaSet:    rs.Name,
			UID:           string(rs.UID),
			Created:       rs.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
			Replicas:      rs.Status.Replicas,
			ReadyReplicas: rs.Status.ReadyReplicas,
			Current:       rev == currentRev,
			Images:        containerImages(rs.Spec.Template.Spec.Containers),
			ChangeCause:   rs.Annotations[changeCauseAnnotation],
			Template:      template,
			Labels:        rs.Spec.Template.Labels,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Revision > out[j].Revision })
	return out, currentRev, nil
}

func findRevision(ctx context.Context, apps appsv1client.AppsV1Interface, dep *appsv1.Deployment, revision int64) (*appsv1.ReplicaSet, int64, error) {
	rsList, err := apps.ReplicaSets(dep.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, 0, err
	}
	currentRev, _ := strconv.ParseInt(dep.Annotations[revisionAnnotation], 10, 64)
	for i := range rsList.Items {
		rs := &rsList.Items[i]
		if !ownedBy(rs.OwnerReferences, dep.UID) {
			continue
		}
		rev, _ := strconv.ParseInt(rs.Annotations[revisionAnnotation], 10, 64)
		if rev == revision {
			return rs, currentRev, nil
		}
	}
	return nil, currentRev, nil
}

func ownedBy(refs []metav1.OwnerReference, uid types.UID) bool {
	for _, ref := range refs {
		if ref.UID == uid {
			return true
		}
	}
	return false
}

func containerImages(cs []corev1.Container) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Image)
	}
	return out
}

func encodeAsMap(v any) (map[string]any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func statusFor(err error) int {
	if apierrors.IsNotFound(err) {
		return http.StatusNotFound
	}
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		return http.StatusForbidden
	}
	return http.StatusBadGateway
}
