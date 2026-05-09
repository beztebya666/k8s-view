package api

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	policyv1 "k8s.io/api/policy/v1"
)

func isMirrorPod(annotations map[string]string) bool {
	_, ok := annotations["kubernetes.io/config.mirror"]
	return ok
}

func isDaemonSetPod(refs []metav1.OwnerReference) bool {
	for _, r := range refs {
		if r.Kind == "DaemonSet" {
			return true
		}
	}
	return false
}

func policyEviction(name, ns string) *policyv1.Eviction {
	return &policyv1.Eviction{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}
}
