package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/k8s-view/k8s-view/internal/clusters"
)

// promTarget is the discovered service we proxy queries to. The path is
// always reached through the K8s API server's `services/<svc>:<port>/proxy`
// sub-resource so we don't need direct cluster network access.
type promTarget struct {
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	Port      string `json:"port"`
	Scheme    string `json:"scheme"`
}

// promCache caches the result of detection per-cluster for ~60s. Discovery
// is otherwise expensive (lists services in 5 namespaces) and the answer
// rarely changes during a session.
type promCache struct {
	mu      sync.Mutex
	entries map[string]promCacheEntry
}

type promCacheEntry struct {
	target  *promTarget
	at      time.Time
	missErr string
}

var promDiscoveryCache = &promCache{entries: map[string]promCacheEntry{}}

// Common namespace + service name combos used by helm charts and operators.
var promNamespaceCandidates = []string{
	"monitoring",
	"kube-prometheus-stack",
	"prometheus",
	"observability",
	"kube-system",
}

var promServiceNameCandidates = []string{
	"kube-prometheus-stack-prometheus",
	"prometheus-operated",
	"prometheus-k8s",
	"prometheus-server",
	"prometheus",
}

// Acceptable port names/numbers, in priority order.
var promPortCandidates = []string{"web", "http-web", "http", "9090"}

func discoverPrometheus(ctx context.Context, c *clusters.Cluster) (*promTarget, error) {
	const ttl = 60 * time.Second
	now := time.Now()

	promDiscoveryCache.mu.Lock()
	if entry, ok := promDiscoveryCache.entries[c.Name()]; ok && now.Sub(entry.at) < ttl {
		promDiscoveryCache.mu.Unlock()
		if entry.target != nil {
			return entry.target, nil
		}
		if entry.missErr != "" {
			return nil, errors.New(entry.missErr)
		}
		return nil, errors.New("Prometheus not detected")
	}
	promDiscoveryCache.mu.Unlock()

	target, err := probePrometheus(ctx, c)
	promDiscoveryCache.mu.Lock()
	defer promDiscoveryCache.mu.Unlock()
	if err != nil || target == nil {
		msg := "Prometheus not detected"
		if err != nil {
			msg = err.Error()
		}
		promDiscoveryCache.entries[c.Name()] = promCacheEntry{at: now, missErr: msg}
		if err != nil {
			return nil, err
		}
		return nil, errors.New(msg)
	}
	promDiscoveryCache.entries[c.Name()] = promCacheEntry{at: now, target: target}
	return target, nil
}

// probePrometheus walks the namespace candidates and returns the first
// service whose name matches one of our candidates and that exposes a
// recognisable HTTP port.
func probePrometheus(ctx context.Context, c *clusters.Cluster) (*promTarget, error) {
	cs := c.Clientset()
	if cs == nil {
		return nil, errors.New("cluster client unavailable")
	}
	for _, ns := range promNamespaceCandidates {
		probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		list, err := cs.CoreV1().Services(ns).List(probeCtx, metav1.ListOptions{})
		cancel()
		if err != nil {
			// Namespace probably doesn't exist or RBAC denies — keep going.
			continue
		}
		if t := pickPromService(list.Items, ns); t != nil {
			return t, nil
		}
	}
	return nil, errors.New("Prometheus service not found in known namespaces")
}

func pickPromService(services []corev1.Service, ns string) *promTarget {
	// Try named matches first (in priority order), then fall back to any
	// service with a recognisable Prometheus port.
	byName := make(map[string]*corev1.Service, len(services))
	for i := range services {
		byName[services[i].Name] = &services[i]
	}
	for _, name := range promServiceNameCandidates {
		svc, ok := byName[name]
		if !ok {
			continue
		}
		if port := pickPromPort(svc.Spec.Ports); port != "" {
			return &promTarget{
				Namespace: ns,
				Service:   svc.Name,
				Port:      port,
				Scheme:    "http",
			}
		}
	}
	// Fallback: anything with `prometheus` in the name plus a matching port.
	for i := range services {
		svc := &services[i]
		if !strings.Contains(strings.ToLower(svc.Name), "prometheus") {
			continue
		}
		if port := pickPromPort(svc.Spec.Ports); port != "" {
			return &promTarget{
				Namespace: ns,
				Service:   svc.Name,
				Port:      port,
				Scheme:    "http",
			}
		}
	}
	return nil
}

func pickPromPort(ports []corev1.ServicePort) string {
	if len(ports) == 0 {
		return ""
	}
	byName := make(map[string]corev1.ServicePort, len(ports))
	for _, p := range ports {
		byName[strings.ToLower(p.Name)] = p
	}
	for _, c := range promPortCandidates {
		if p, ok := byName[c]; ok {
			if p.Name != "" {
				return p.Name
			}
			return strconv.Itoa(int(p.Port))
		}
	}
	for _, p := range ports {
		if p.Port == 9090 {
			if p.Name != "" {
				return p.Name
			}
			return "9090"
		}
	}
	return ""
}

func (h *handlers) prometheusInfo(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	target, err := discoverPrometheus(r.Context(), c)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"detected": false,
			"reason":   err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"detected":  true,
		"namespace": target.Namespace,
		"service":   target.Service,
		"port":      target.Port,
		"scheme":    target.Scheme,
	})
}

func (h *handlers) prometheusQuery(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	q := r.URL.Query().Get("query")
	if q == "" {
		h.writeError(w, r, http.StatusBadRequest, errors.New("query is required"))
		return
	}
	params := map[string]string{"query": q}
	if t := r.URL.Query().Get("time"); t != "" {
		params["time"] = t
	}
	h.proxyPromAPI(w, r, c, "api/v1/query", params)
}

func (h *handlers) prometheusQueryRange(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	q := r.URL.Query().Get("query")
	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")
	step := r.URL.Query().Get("step")
	if q == "" || start == "" || end == "" || step == "" {
		h.writeError(w, r, http.StatusBadRequest, errors.New("query, start, end, step are required"))
		return
	}
	params := map[string]string{
		"query": q,
		"start": start,
		"end":   end,
		"step":  step,
	}
	h.proxyPromAPI(w, r, c, "api/v1/query_range", params)
}

// proxyPromAPI forwards a request to Prometheus through the K8s API server's
// `services/<svc>:<port>/proxy/<suffix>` sub-resource. This works without
// direct network reachability to the Prometheus pod and inherits the existing
// kubeconfig auth.
func (h *handlers) proxyPromAPI(w http.ResponseWriter, r *http.Request, c *clusters.Cluster, suffix string, params map[string]string) {
	target, err := discoverPrometheus(r.Context(), c)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "error",
			"errorType": "no_target",
			"error":     err.Error(),
		})
		return
	}
	cs := c.Clientset()
	if cs == nil {
		h.writeError(w, r, http.StatusInternalServerError, errors.New("cluster client unavailable"))
		return
	}

	scheme := target.Scheme
	if scheme == "" {
		scheme = "http"
	}
	// ProxyGet itself joins scheme/name/port into the `services/<svc>:<port>`
	// resource name expected by the API server.
	req := cs.CoreV1().Services(target.Namespace).ProxyGet(scheme, target.Service, target.Port, suffix, params)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	stream, err := req.Stream(ctx)
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, fmt.Errorf("prometheus proxy: %w", err))
		return
	}
	defer stream.Close()

	body, err := io.ReadAll(stream)
	if err != nil {
		h.writeError(w, r, http.StatusBadGateway, err)
		return
	}

	// Pass through the JSON body verbatim. Validate it parses so we don't
	// emit malformed payloads to the UI.
	var probe any
	if err := json.Unmarshal(body, &probe); err != nil {
		h.writeError(w, r, http.StatusBadGateway, fmt.Errorf("prometheus returned non-JSON: %w", err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
