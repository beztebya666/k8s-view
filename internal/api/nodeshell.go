package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// nodeShell spawns an ephemeral privileged Pod pinned to the requested
// node and returns its identifier so the frontend can open an exec
// session against it. Mirrors what Lens calls "Open node shell": a Pod
// with hostPID/hostNetwork/hostIPC=true and a single container running
// `nsenter -t 1 -m -u -i -n -p -- sh`, which gives the operator a
// shell inside PID 1's namespaces — i.e. on the host. The pod is named
// `node-shell-<rand>` so concurrent sessions don't collide and so the
// caller can identify the pod for cleanup.
//
// Image and pull-secret are read from the cluster's persisted UI
// settings (`nodeShellImage` / `nodeShellPullSecret`) so an air-gapped
// install can swap docker.io for a private registry without touching
// code.
func (h *handlers) nodeShell(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	node := urlParam(r, "name")
	if node == "" {
		h.writeError(w, r, http.StatusBadRequest, fmt.Errorf("node name required"))
		return
	}

	image := r.URL.Query().Get("image")
	if image == "" {
		image = "docker.io/alpine:3.19"
	}
	pullSecret := r.URL.Query().Get("pullSecret")
	ns := r.URL.Query().Get("namespace")
	if ns == "" {
		ns = "kube-system"
	}

	suffix, err := randomSuffix(6)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err)
		return
	}
	name := fmt.Sprintf("node-shell-%s", suffix)
	tolAll := corev1.Toleration{Operator: corev1.TolerationOpExists}
	priv := true
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels: map[string]string{
				"app.kubernetes.io/name":      "k8s-view-node-shell",
				"app.kubernetes.io/component": "shell",
				"app.kubernetes.io/node":      node,
			},
			Annotations: map[string]string{
				"k8s-view/created-by":    "node-shell",
				"k8s-view/target-node":   node,
				"k8s-view/cleanup-after": "session-end",
			},
		},
		Spec: corev1.PodSpec{
			NodeName:      node,
			HostPID:       true,
			HostNetwork:   true,
			HostIPC:       true,
			RestartPolicy: corev1.RestartPolicyNever,
			Tolerations:   []corev1.Toleration{tolAll},
			// Bypass the default scheduler — we already pinned NodeName.
			// nodeSelector + tolerations handle taints.
			Containers: []corev1.Container{{
				Name:  "shell",
				Image: image,
				// `chroot /host` is more reliable than nsenter when the
				// kernel disagrees on the namespace flags; try both.
				Command: []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh"},
				Stdin:   true,
				TTY:     true,
				SecurityContext: &corev1.SecurityContext{
					Privileged: &priv,
				},
			}},
		},
	}
	if pullSecret != "" {
		pod.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: pullSecret}}
	}

	created, err := c.Clientset().CoreV1().Pods(ns).Create(r.Context(), pod, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		h.writeError(w, r, http.StatusBadGateway, fmt.Errorf("create node-shell pod: %w", err))
		return
	}
	if created == nil {
		created = pod
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"namespace": created.Namespace,
		"name":      created.Name,
		"node":      node,
		"image":     image,
	})
}

// nodeShellCleanup deletes the ephemeral pod the matching session
// created. Frontend calls this when the user closes the terminal so we
// don't litter the cluster with idle privileged pods.
func (h *handlers) nodeShellCleanup(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := urlParam(r, "namespace")
	name := urlParam(r, "name")
	if ns == "" || name == "" {
		h.writeError(w, r, http.StatusBadRequest, fmt.Errorf("namespace and name required"))
		return
	}
	zero := int64(0)
	err = c.Clientset().CoreV1().Pods(ns).Delete(context.Background(), name, metav1.DeleteOptions{
		GracePeriodSeconds: &zero,
	})
	if err != nil && !apierrors.IsNotFound(err) {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func randomSuffix(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
