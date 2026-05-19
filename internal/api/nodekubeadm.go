package api

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// nodeKubeadm runs a kubeadm maintenance operation on a control-plane
// node by spawning a one-shot privileged Pod pinned to it that nsenters
// the host and invokes the host's own kubeadm — the same mechanism as
// "Open node shell", just non-interactive. The Pod's logs are the
// operation's transcript; the frontend opens them so the operator
// watches it run.
//
// These are the most destructive actions in the product (control-plane
// cert rotation, version upgrade), so the handler is hard-gated:
//
//   * the target MUST be a control-plane node — kubeadm certs/upgrade
//     are meaningless on workers, and refusing protects against a
//     fat-fingered node pick;
//   * the caller MUST echo the node name in `confirm=` — the UI only
//     sends that after a typed confirmation, so a stray POST can't
//     rotate a prod cluster's certs;
//   * `version` is whitelisted to a strict charset before it's ever
//     interpolated into the shell script (command-injection guard).
var kubeadmVersionRe = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`)

func (h *handlers) nodeKubeadm(w http.ResponseWriter, r *http.Request) {
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

	op := r.URL.Query().Get("op")
	if op != "certs-renew" && op != "upgrade" {
		h.writeError(w, r, http.StatusBadRequest, fmt.Errorf(`op must be "certs-renew" or "upgrade"`))
		return
	}

	// Typed-confirmation gate: the UI only ever sends confirm=<node>
	// after the user types the node name into a danger modal.
	if r.URL.Query().Get("confirm") != node {
		h.writeError(w, r, http.StatusForbidden,
			fmt.Errorf("confirmation token does not match node name; refusing"))
		return
	}

	nodeObj, err := c.Clientset().CoreV1().Nodes().Get(r.Context(), node, metav1.GetOptions{})
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, fmt.Errorf("get node: %w", err))
		return
	}
	if !isControlPlane(nodeObj) {
		h.writeError(w, r, http.StatusBadRequest,
			fmt.Errorf("%s is not a control-plane node; kubeadm certs/upgrade only apply there", node))
		return
	}

	version := strings.TrimSpace(r.URL.Query().Get("version"))
	if version != "" && !kubeadmVersionRe.MatchString(version) {
		h.writeError(w, r, http.StatusBadRequest,
			fmt.Errorf("invalid version %q (expected e.g. v1.30.2)", version))
		return
	}

	script := kubeadmScript(op, version)

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
	name := fmt.Sprintf("kubeadm-%s-%s", shortOp(op), suffix)
	tolAll := corev1.Toleration{Operator: corev1.TolerationOpExists}
	priv := true
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels: map[string]string{
				"app.kubernetes.io/name":      "k8s-view-kubeadm",
				"app.kubernetes.io/component": op,
				"app.kubernetes.io/node":      node,
			},
			Annotations: map[string]string{
				"k8s-view/created-by":  "node-kubeadm",
				"k8s-view/target-node": node,
				"k8s-view/op":          op,
			},
		},
		Spec: corev1.PodSpec{
			NodeName:      node,
			HostPID:       true,
			HostNetwork:   true,
			HostIPC:       true,
			RestartPolicy: corev1.RestartPolicyNever,
			Tolerations:   []corev1.Toleration{tolAll},
			Containers: []corev1.Container{{
				Name:  "kubeadm",
				Image: image,
				Command: []string{
					"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
					"sh", "-c", script,
				},
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
		h.writeError(w, r, http.StatusBadGateway, fmt.Errorf("create kubeadm pod: %w", err))
		return
	}
	if created == nil {
		created = pod
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"namespace": created.Namespace,
		"name":      created.Name,
		"node":      node,
		"op":        op,
		"container": "kubeadm",
	})
}

func isControlPlane(n *corev1.Node) bool {
	for k := range n.Labels {
		if k == "node-role.kubernetes.io/control-plane" || k == "node-role.kubernetes.io/master" {
			return true
		}
	}
	return false
}

func shortOp(op string) string {
	if op == "certs-renew" {
		return "certs"
	}
	return "upgrade"
}

func kubeadmScript(op, version string) string {
	if op == "certs-renew" {
		// Renew every cert, then bounce the control-plane static pods so
		// they pick the new certs up. kubelet only restarts a static pod
		// when its manifest changes, so the canonical trick is to move
		// the manifests out for a beat and back in. etcd is included —
		// its peer/server certs are renewed too.
		return `set -e
echo "[k8s-view] kubeadm certs renew all"
kubeadm certs renew all
echo "[k8s-view] bouncing control-plane static pods to load new certs"
mkdir -p /tmp/k8s-view-manifests
cd /etc/kubernetes/manifests
for m in kube-apiserver kube-controller-manager kube-scheduler etcd; do
  [ -f "$m.yaml" ] && mv "$m.yaml" /tmp/k8s-view-manifests/ || true
done
sleep 25
mv /tmp/k8s-view-manifests/*.yaml /etc/kubernetes/manifests/ 2>/dev/null || true
sleep 10
echo "[k8s-view] new certificate expirations:"
kubeadm certs check-expiration || true
echo "[k8s-view] done"`
	}
	// upgrade
	upgradeCmd := "kubeadm upgrade node"
	if version != "" {
		upgradeCmd = fmt.Sprintf("kubeadm upgrade apply -y %s", version)
	}
	return fmt.Sprintf(`set -e
echo "[k8s-view] kubeadm version:"
kubeadm version
echo "[k8s-view] running: %s"
%s
echo "[k8s-view] restarting kubelet"
systemctl restart kubelet || true
echo "[k8s-view] done"`, upgradeCmd, upgradeCmd)
}
