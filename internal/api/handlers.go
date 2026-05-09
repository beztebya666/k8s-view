package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/yaml"

	"github.com/k8s-view/k8s-view/internal/auth"
	"github.com/k8s-view/k8s-view/internal/clusters"
)

func readFile(p string) ([]byte, error) {
	return os.ReadFile(p)
}

type handlers struct {
	deps Deps
}

// managerFor returns the Manager scoped to the request's identity. Every
// per-cluster handler funnels through this — it's the single chokepoint
// that enforces "user A's clusters never appear under user B's session".
func (h *handlers) managerFor(r *http.Request) (*clusters.Manager, error) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		// Should never happen — the router's auth middleware runs before
		// every handler that needs an identity. Surface clearly if it does
		// (means a route was mounted outside the middleware chain).
		return nil, fmt.Errorf("internal: no identity in request context")
	}
	return h.deps.Registry.For(id.ID)
}

func (h *handlers) cluster(r *http.Request) (*clusters.Cluster, error) {
	mgr, err := h.managerFor(r)
	if err != nil {
		return nil, err
	}
	name := chi.URLParam(r, "cluster")
	c, ok := mgr.Get(name)
	if !ok {
		return nil, fmt.Errorf("cluster %q not found", name)
	}
	return c, nil
}

func (h *handlers) gvr(r *http.Request) schema.GroupVersionResource {
	g := chi.URLParam(r, "group")
	if g == "core" || g == "_" {
		g = ""
	}
	return schema.GroupVersionResource{
		Group:    g,
		Version:  chi.URLParam(r, "version"),
		Resource: chi.URLParam(r, "resource"),
	}
}

func (h *handlers) healthz(w http.ResponseWriter, _ *http.Request) {
	// `serverTime` lets the browser correct for its own clock skew when
	// computing object ages. Without this a user with a clock 40s off real
	// time would see a freshly-created pod stamped "40s old" the moment it
	// arrives — the very same skew that makes Lens, k9s, and kubectl all
	// look "wrong" against an unsynchronised laptop.
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"serverTime": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (h *handlers) version(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"version": h.deps.Version,
		"commit":  h.deps.Commit,
	})
}

// whoAmI surfaces the current identity so the Settings page can show the
// device cookie value (for the "restore on another browser" flow). Only the
// device kind is meaningful in v1 — SSO will extend this with username/email.
func (h *handlers) whoAmI(w http.ResponseWriter, r *http.Request) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		h.writeError(w, r, http.StatusInternalServerError, errors.New("no identity"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":          id.ID,
		"kind":        id.Kind,
		"displayName": id.DisplayName,
	})
}

// adoptDevice writes the supplied device ID as the current cookie. Used by
// the "restore device" flow — the user pastes their device ID from another
// browser, the server adopts it, refresh, and the saved kubeconfigs are
// back. Restricted to "device"-kind providers since SSO sessions don't use
// the device cookie.
func (h *handlers) adoptDevice(w http.ResponseWriter, r *http.Request) {
	if h.deps.Devices == nil {
		h.writeError(w, r, http.StatusBadRequest, errors.New("device-cookie provider not enabled"))
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		h.writeError(w, r, http.StatusBadRequest, fmt.Errorf("invalid JSON: %w", err))
		return
	}
	if err := h.deps.Devices.AdoptDeviceID(w, r, body.ID); err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"adopted": body.ID})
}

func (h *handlers) listClusters(w http.ResponseWriter, r *http.Request) {
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, mgr.List())
}

func (h *handlers) removeCluster(w http.ResponseWriter, r *http.Request) {
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	name := chi.URLParam(r, "name")
	if err := mgr.Remove(name); err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"removed": name})
}

func (h *handlers) selectCluster(w http.ResponseWriter, r *http.Request) {
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	name := chi.URLParam(r, "name")
	if err := mgr.SetCurrent(name); err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"current": name})
}

// disconnectCluster pauses the named cluster — running informers stop,
// new subscribes / streams return ErrClusterPaused, the connectivity probe
// idles. Idempotent. The cluster stays in the picker so a single click on
// Connect re-enables it without re-importing.
func (h *handlers) disconnectCluster(w http.ResponseWriter, r *http.Request) {
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	name := chi.URLParam(r, "name")
	if err := mgr.Disconnect(name); err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"disconnected": name})
}

// connectCluster is the inverse of disconnect — flips the cluster back to
// active. Idempotent. The next Subscribe rebuilds informers on demand.
func (h *handlers) connectCluster(w http.ResponseWriter, r *http.Request) {
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	name := chi.URLParam(r, "name")
	if err := mgr.Connect(name); err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"connected": name})
}

// importCluster accepts a kubeconfig YAML payload and registers each context
// it contains as a Cluster. The YAML is also persisted to
// ~/.k8s-view/imported/ so the cluster reappears on next startup.
func (h *handlers) importCluster(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string `json:"name"`
		Kubeconfig string `json:"kubeconfig"`
		// Path is the alternative entry point for the Welcome scan flow:
		// instead of pasting YAML the user picks one of the paths returned
		// by /clusters/scan and we read it server-side. Resolved against
		// the same KUBECONFIG-precedence loader to make symlinks Just Work.
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		h.writeError(w, r, http.StatusBadRequest, fmt.Errorf("invalid JSON: %w", err))
		return
	}
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	yamlBytes := []byte(body.Kubeconfig)
	if strings.TrimSpace(body.Kubeconfig) == "" && strings.TrimSpace(body.Path) != "" {
		// Only allow paths the scanner already knows about — prevents the
		// route from being used as an arbitrary file-reader by a hostile
		// frontend (or a stolen session cookie).
		allowed := false
		for _, c := range mgr.ScanLocalKubeconfigs() {
			if c.Path == body.Path {
				allowed = true
				break
			}
		}
		if !allowed {
			h.writeError(w, r, http.StatusBadRequest, errors.New("path is not on the KUBECONFIG precedence list"))
			return
		}
		raw, err := readFile(body.Path)
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, err)
			return
		}
		yamlBytes = raw
	}
	if len(strings.TrimSpace(string(yamlBytes))) == 0 {
		h.writeError(w, r, http.StatusBadRequest, errors.New("kubeconfig is required"))
		return
	}
	added, err := mgr.ImportKubeconfig(r.Context(), body.Name, yamlBytes, true)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	if len(added) == 0 {
		h.writeError(w, r, http.StatusBadRequest, errors.New("no contexts could be loaded from the kubeconfig"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"imported": added,
	})
}

// scanKubeconfigs walks the KUBECONFIG-precedence files on the backend
// host and returns the contexts found, secrets stripped. Used by the
// Welcome wizard so the user can pick contexts to import without ever
// having to paste a kubeconfig manually. Same trust boundary as
// `importCluster` — both rely on the operator running k8s-view in an
// environment where the kubeconfig file is something they want exposed.
func (h *handlers) scanKubeconfigs(w http.ResponseWriter, r *http.Request) {
	mgr, err := h.managerFor(r)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	contexts := mgr.ScanLocalKubeconfigs()
	// Group by file path so the wizard can render "all contexts in X"
	// alongside their import-as-yaml payload, while still keeping the
	// flat list for those that prefer one-by-one import.
	byPath := make(map[string][]LocalKubeconfigContextPublic)
	for _, c := range contexts {
		byPath[c.Path] = append(byPath[c.Path], LocalKubeconfigContextPublic{
			Context:        c.Context,
			Cluster:        c.Cluster,
			Server:         c.Server,
			Namespace:      c.Namespace,
			User:           c.User,
			CurrentContext: c.CurrentContext,
		})
	}
	files := make([]map[string]any, 0, len(byPath))
	for p, list := range byPath {
		files = append(files, map[string]any{
			"path":     p,
			"contexts": list,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contexts": contexts,
		"files":    files,
	})
}

// LocalKubeconfigContextPublic mirrors clusters.LocalKubeconfigContext
// without the file path duplicated for every entry — the wizard groups
// by path on the server side, so the per-context shape is leaner.
type LocalKubeconfigContextPublic struct {
	Context        string `json:"context"`
	Cluster        string `json:"cluster"`
	Server         string `json:"server,omitempty"`
	Namespace      string `json:"namespace,omitempty"`
	User           string `json:"user,omitempty"`
	CurrentContext bool   `json:"currentContext"`
}

func (h *handlers) apiResources(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	rs, err := c.ListAPIResources()
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, rs)
}

func (h *handlers) listNamespaces(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns, err := c.ListNamespaces(r.Context())
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, ns)
}

func (h *handlers) listResource(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	gvr := h.gvr(r)
	ns := chi.URLParam(r, "namespace")
	var (
		ri  = c.Dynamic().Resource(gvr)
		out *unstructured.UnstructuredList
	)
	if ns != "" {
		out, err = ri.Namespace(ns).List(r.Context(), metav1.ListOptions{})
	} else {
		out, err = ri.List(r.Context(), metav1.ListOptions{})
	}
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *handlers) getResource(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	gvr := h.gvr(r)
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	ri := c.Dynamic().Resource(gvr)
	var obj *unstructured.Unstructured
	if ns != "" {
		obj, err = ri.Namespace(ns).Get(r.Context(), name, metav1.GetOptions{})
	} else {
		obj, err = ri.Get(r.Context(), name, metav1.GetOptions{})
	}
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, obj)
}

func (h *handlers) applyResource(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	gvr := h.gvr(r)
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	defer r.Body.Close()

	jsonBody, err := normaliseToJSON(body)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}

	// dryRun=All asks the apiserver to validate + return the *would-be*
	// post-merge object without persisting it. The frontend uses this to
	// render a server-side diff preview before the user actually saves.
	patchOpts := metav1.PatchOptions{FieldManager: "k8s-view", Force: ptrBool(true)}
	if r.URL.Query().Get("dryRun") == "All" {
		patchOpts.DryRun = []string{metav1.DryRunAll}
	}

	ri := c.Dynamic().Resource(gvr)
	var obj *unstructured.Unstructured
	if ns != "" {
		obj, err = ri.Namespace(ns).Patch(r.Context(), name, types.ApplyPatchType, jsonBody, patchOpts)
	} else {
		obj, err = ri.Patch(r.Context(), name, types.ApplyPatchType, jsonBody, patchOpts)
	}
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, obj)
}

func (h *handlers) deleteResource(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	gvr := h.gvr(r)
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	policy := metav1.DeletePropagationBackground
	if p := r.URL.Query().Get("propagation"); p != "" {
		policy = metav1.DeletionPropagation(p)
	}
	opts := metav1.DeleteOptions{PropagationPolicy: &policy}
	if r.URL.Query().Get("force") == "true" {
		grace := int64(0)
		opts.GracePeriodSeconds = &grace
	}

	ri := c.Dynamic().Resource(gvr)
	if ns != "" {
		err = ri.Namespace(ns).Delete(r.Context(), name, opts)
	} else {
		err = ri.Delete(r.Context(), name, opts)
	}
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "deleted"})
}

func (h *handlers) serverSideApply(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	defer r.Body.Close()
	jsonBody, err := normaliseToJSON(body)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	obj := &unstructured.Unstructured{}
	if err := obj.UnmarshalJSON(jsonBody); err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	gvk := obj.GroupVersionKind()
	mapping, err := c.Mapper().RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, err)
		return
	}
	ri := c.Dynamic().Resource(mapping.Resource)
	var out *unstructured.Unstructured
	if mapping.Scope.Name() == "namespace" {
		ns := obj.GetNamespace()
		if ns == "" {
			ns = "default"
		}
		out, err = ri.Namespace(ns).Patch(r.Context(), obj.GetName(), types.ApplyPatchType,
			jsonBody, metav1.PatchOptions{FieldManager: "k8s-view", Force: ptrBool(true)})
	} else {
		out, err = ri.Patch(r.Context(), obj.GetName(), types.ApplyPatchType,
			jsonBody, metav1.PatchOptions{FieldManager: "k8s-view", Force: ptrBool(true)})
	}
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *handlers) scale(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	gvr := h.gvr(r)
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	replicasStr := r.URL.Query().Get("replicas")
	replicas, err := strconv.ParseInt(replicasStr, 10, 32)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, errors.New("replicas must be an integer"))
		return
	}
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, replicas))
	obj, err := c.Dynamic().Resource(gvr).Namespace(ns).Patch(
		r.Context(), name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, obj)
}

func (h *handlers) restart(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	gvr := h.gvr(r)
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	patch := fmt.Appendf(nil,
		`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"%s"}}}}}`,
		metav1.Now().UTC().Format("2006-01-02T15:04:05Z"))
	obj, err := c.Dynamic().Resource(gvr).Namespace(ns).Patch(
		r.Context(), name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, obj)
}

func (h *handlers) cordon(w http.ResponseWriter, r *http.Request) {
	h.toggleCordon(w, r, true)
}

func (h *handlers) uncordon(w http.ResponseWriter, r *http.Request) {
	h.toggleCordon(w, r, false)
}

func (h *handlers) toggleCordon(w http.ResponseWriter, r *http.Request, value bool) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	name := chi.URLParam(r, "name")
	patch := []byte(fmt.Sprintf(`{"spec":{"unschedulable":%t}}`, value))
	_, err = c.Clientset().CoreV1().Nodes().Patch(
		r.Context(), name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"unschedulable": value})
}

func (h *handlers) drain(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	name := chi.URLParam(r, "name")
	// Step 1: cordon
	patch := []byte(`{"spec":{"unschedulable":true}}`)
	if _, err := c.Clientset().CoreV1().Nodes().Patch(
		r.Context(), name, types.StrategicMergePatchType, patch, metav1.PatchOptions{}); err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	// Step 2: evict pods running on this node, skipping mirror pods and DaemonSets.
	pods, err := c.Clientset().CoreV1().Pods("").List(r.Context(), metav1.ListOptions{
		FieldSelector: "spec.nodeName=" + name,
	})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	evicted := 0
	skipped := 0
	for _, p := range pods.Items {
		if isMirrorPod(p.Annotations) {
			skipped++
			continue
		}
		if isDaemonSetPod(p.OwnerReferences) {
			skipped++
			continue
		}
		err := c.Clientset().PolicyV1().Evictions(p.Namespace).Evict(r.Context(),
			policyEviction(p.Name, p.Namespace))
		if err != nil {
			skipped++
			continue
		}
		evicted++
	}
	writeJSON(w, http.StatusOK, map[string]int{"evicted": evicted, "skipped": skipped})
}

func (h *handlers) evictPod(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if ns == "" || name == "" {
		h.writeError(w, r, http.StatusBadRequest, fmt.Errorf("namespace and name are required"))
		return
	}
	if err := c.Clientset().PolicyV1().Evictions(ns).Evict(r.Context(),
		policyEviction(name, ns)); err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"evicted": true})
}

func (h *handlers) eventsByNamespace(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	if ns == "_all" {
		ns = ""
	}
	evs, err := c.Clientset().CoreV1().Events(ns).List(r.Context(), metav1.ListOptions{Limit: 1000})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, evs)
}

func (h *handlers) podMetrics(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	if c.Metrics() == nil {
		h.writeError(w, r, http.StatusNotImplemented, errors.New("metrics-server unavailable"))
		return
	}
	ns := chi.URLParam(r, "namespace")
	if ns == "_all" {
		ns = ""
	}
	list, err := c.Metrics().MetricsV1beta1().PodMetricses(ns).List(r.Context(), metav1.ListOptions{})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *handlers) nodeMetrics(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	if c.Metrics() == nil {
		h.writeError(w, r, http.StatusNotImplemented, errors.New("metrics-server unavailable"))
		return
	}
	list, err := c.Metrics().MetricsV1beta1().NodeMetricses().List(r.Context(), metav1.ListOptions{})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func normaliseToJSON(body []byte) ([]byte, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, errors.New("empty body")
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		// already JSON; validate
		var x interface{}
		if err := json.Unmarshal(body, &x); err != nil {
			return nil, err
		}
		return body, nil
	}
	return yaml.YAMLToJSON(body)
}

func ptrBool(b bool) *bool { return &b }
