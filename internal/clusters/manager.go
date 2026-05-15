// Package clusters owns the connections to every Kubernetes cluster
// k8s-view knows about, plus the per-cluster shared informers that feed
// real-time deltas to subscribers.
package clusters

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"

	"github.com/k8s-view/k8s-view/internal/config"
)

// Manager owns Cluster objects, one per kube-context. It is the entry point
// for the API layer.
//
// In multi-device mode (the default), Manager is per-identity: one instance
// per device cookie / SSO user, each with its own clusters/imports/current.
// IdentityID names the on-disk directory under ~/.k8s-view/devices/. When
// IdentityID is empty, the legacy single-instance path is used (in-cluster
// mode and the bootstrap manager that adopts host kubeconfigs).
type Manager struct {
	cfg        *config.Config
	logger     *zap.Logger
	rootCtx    context.Context
	IdentityID string

	mu       sync.RWMutex
	clusters map[string]*Cluster
	order    []string
	current  string
	// loadedFiles tracks the absolute paths of kubeconfig YAMLs already
	// merged into m.clusters. LoadImported uses this to stay idempotent
	// across repeated calls (startup → ImportKubeconfig → future fsnotify
	// watcher); without it, re-reading the same file would rename every
	// context to "<name>-2", "<name>-3", and so on. Mutated under m.mu so
	// it can be inspected and updated atomically alongside m.clusters.
	loadedFiles map[string]struct{}

	wg sync.WaitGroup
}

// NewManager loads kubeconfig (or in-cluster credentials) and prepares a
// Cluster object for every context. Informers are *not* started until a
// browser actually subscribes to them.
//
// This constructor is the legacy single-instance entry point. In multi-
// device mode the Registry calls NewManagerForIdentity instead, which skips
// host kubeconfig loading so each device starts with only its own imports.
func NewManager(ctx context.Context, cfg *config.Config, logger *zap.Logger) (*Manager, error) {
	m := &Manager{
		cfg:      cfg,
		logger:   logger,
		rootCtx:  ctx,
		clusters: make(map[string]*Cluster),
	}

	if cfg.InCluster {
		rc, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
		tuneRESTConfig(rc)
		name := "in-cluster"
		c, err := newCluster(ctx, name, rc, logger.With(zap.String("cluster", name)))
		if err != nil {
			return nil, err
		}
		c.origin = OriginInCluster
		m.clusters[name] = c
		m.order = []string{name}
		m.current = name
		return m, nil
	}

	loader := clientcmd.NewDefaultClientConfigLoadingRules()
	if cfg.Kubeconfig != "" {
		loader.ExplicitPath = cfg.Kubeconfig
	}
	raw, err := loader.Load()
	if err != nil {
		logger.Warn("kubeconfig could not be loaded; starting without initial clusters",
			zap.String("path", cfg.Kubeconfig),
			zap.Error(err))
		raw = clientcmdapi.NewConfig()
	}

	names := make([]string, 0, len(raw.Contexts))
	for name := range raw.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		clientCfg := clientcmd.NewNonInteractiveClientConfig(
			*raw, name, &clientcmd.ConfigOverrides{}, loader,
		)
		rc, err := clientCfg.ClientConfig()
		if err != nil {
			logger.Warn("skipping context: failed to build rest.Config",
				zap.String("context", name), zap.Error(err))
			continue
		}
		// Sane client-side defaults to avoid the API server throttling us
		// when the UI subscribes to many resource types at once.
		tuneRESTConfig(rc)
		if isLoopbackServer(rc.Host) {
			logger.Warn("kubeconfig server uses a loopback address; this usually breaks inside Docker unless the container uses host networking",
				zap.String("context", name),
				zap.String("server", rc.Host),
				zap.String("hint", "run with --network host on Linux, or change the kubeconfig server to an address reachable from the container"))
		}
		c, err := newCluster(ctx, name, rc, logger.With(zap.String("cluster", name)))
		if err != nil {
			logger.Warn("skipping context: cluster init failed",
				zap.String("context", name), zap.Error(err))
			continue
		}
		c.origin = OriginHostKubeconfig
		m.clusters[name] = c
		m.order = append(m.order, name)
	}

	// Layer in any kubeconfigs the user has imported via the API. These are
	// stored in ~/.k8s-view/imported and re-loaded on every start.
	m.LoadImported(ctx)

	if len(m.clusters) == 0 {
		logger.Info("cluster manager ready",
			zap.Int("clusters", 0),
			zap.String("default", ""))
		return m, nil
	}

	switch {
	case cfg.DefaultClusterName != "" && m.clusters[cfg.DefaultClusterName] != nil:
		m.current = cfg.DefaultClusterName
	case raw.CurrentContext != "" && m.clusters[raw.CurrentContext] != nil:
		m.current = raw.CurrentContext
	default:
		m.current = firstClusterName(m.order, m.clusters)
	}

	logger.Info("cluster manager ready",
		zap.Int("clusters", len(m.clusters)),
		zap.String("default", m.current))
	return m, nil
}

func firstClusterName(order []string, clusters map[string]*Cluster) string {
	for _, name := range order {
		if clusters[name] != nil {
			return name
		}
	}
	return ""
}

func tuneRESTConfig(rc *rest.Config) {
	rc.QPS = 100
	rc.Burst = 200
	if rc.Timeout == 0 {
		rc.Timeout = 30 * time.Second
	}
}

func isLoopbackServer(server string) bool {
	u, err := url.Parse(server)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// List returns metadata about every cluster, in stable order.
type ClusterInfo struct {
	Name       string `json:"name"`
	Server     string `json:"server"`
	Kubeconfig string `json:"kubeconfig,omitempty"`
	Current    bool   `json:"current"`
	Connected  bool   `json:"connected"`
	// Paused is true when the user clicked Disconnect — the cluster object
	// stays in the Manager and the kubeconfig stays on disk, but no
	// informers run and Subscribe / stream return ErrClusterPaused. The
	// frontend uses this to render a "Reconnect" affordance instead of
	// hammering the WebSocket and to soften the "offline" badge styling
	// (paused is intentional, offline is "we tried and the apiserver said
	// no").
	Paused  bool   `json:"paused"`
	Version string `json:"version,omitempty"`
	// Origin is one of the OriginXxx constants in import.go — "imported",
	// "in-cluster", "host-kubeconfig". Lets the picker badge clusters by
	// source so the operator can spot (e.g.) the shared host-kubeconfig
	// entry that the legacy single-device mode loads. Empty entries from
	// older serialised state default to "imported" client-side.
	Origin string `json:"origin,omitempty"`
}

func (m *Manager) List() []ClusterInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]ClusterInfo, 0, len(m.order))
	for _, name := range m.order {
		c, ok := m.clusters[name]
		if !ok {
			continue
		}
		origin := c.Origin()
		if origin == "" {
			origin = OriginImported
		}
		out = append(out, ClusterInfo{
			Name:       name,
			Server:     c.RestConfig().Host,
			Kubeconfig: m.kubeconfigPath(),
			Current:    name == m.current,
			Connected:  c.Connected(),
			Paused:     c.Paused(),
			Version:    c.Version(),
			Origin:     origin,
		})
	}
	return out
}

func (m *Manager) kubeconfigPath() string {
	if m.cfg == nil || m.cfg.InCluster {
		return "in-cluster"
	}
	if m.cfg.Kubeconfig != "" {
		return m.cfg.Kubeconfig
	}
	return clientcmd.RecommendedHomeFile
}

// LocalKubeconfigContext is a single context discovered in one of the
// kubeconfig files known to the host. Tokens, certificates and other
// secrets are stripped — the scan endpoint only ever surfaces structural
// information (name, server URL, namespace, controlling file).
type LocalKubeconfigContext struct {
	Path           string `json:"path"`
	Context        string `json:"context"`
	Cluster        string `json:"cluster"`
	Server         string `json:"server,omitempty"`
	Namespace      string `json:"namespace,omitempty"`
	User           string `json:"user,omitempty"`
	CurrentContext bool   `json:"currentContext"`
}

// ScanLocalKubeconfigs walks the user's KUBECONFIG path list (or the
// default ~/.kube/config when KUBECONFIG isn't set) and returns every
// context found. Used by the Welcome wizard to offer one-click import
// without forcing the user to paste YAML.
func (m *Manager) ScanLocalKubeconfigs() []LocalKubeconfigContext {
	loader := clientcmd.NewDefaultClientConfigLoadingRules()
	out := make([]LocalKubeconfigContext, 0)
	seen := make(map[string]bool)
	for _, p := range loader.Precedence {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		raw, err := clientcmd.LoadFromFile(p)
		if err != nil || raw == nil {
			continue
		}
		current := raw.CurrentContext
		for ctxName, ctx := range raw.Contexts {
			if ctx == nil {
				continue
			}
			cluster := raw.Clusters[ctx.Cluster]
			server := ""
			if cluster != nil {
				server = cluster.Server
			}
			out = append(out, LocalKubeconfigContext{
				Path:           p,
				Context:        ctxName,
				Cluster:        ctx.Cluster,
				Server:         server,
				Namespace:      ctx.Namespace,
				User:           ctx.AuthInfo,
				CurrentContext: ctxName == current,
			})
		}
	}
	return out
}

// Get returns the cluster by name.
func (m *Manager) Get(name string) (*Cluster, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if name == "" {
		name = m.current
	}
	c, ok := m.clusters[name]
	return c, ok
}

// Current returns the name of the cluster the UI should select on first load.
func (m *Manager) Current() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.current
}

// Remove tears down the named cluster (informers, WS subscribers) and
// deletes the kubeconfig YAML that defined this context from the
// identity's imported directory. Idempotent — calling Remove on a
// non-existent name returns "unknown cluster".
//
// We DON'T delete the file if other contexts in the same kubeconfig are
// still in use (a kubeconfig with N contexts maps to N Cluster objects;
// removing one shouldn't unlink the file out from under the others).
// `--in-cluster` mode rejects Remove with an error — there's nothing on
// disk to delete and the cluster is the one the pod is bound to.
func (m *Manager) Remove(name string) error {
	if m.cfg != nil && m.cfg.InCluster {
		return fmt.Errorf("cannot remove the in-cluster connection")
	}
	m.mu.Lock()
	c, ok := m.clusters[name]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("unknown cluster %q", name)
	}
	delete(m.clusters, name)
	out := m.order[:0]
	for _, n := range m.order {
		if n != name {
			out = append(out, n)
		}
	}
	m.order = out
	if m.current == name {
		m.current = firstClusterName(m.order, m.clusters)
	}
	m.mu.Unlock()

	// Stop informers + WS subscribers BEFORE filesystem unlink so any
	// in-flight subscribers see EOF rather than reconnecting to a freshly-
	// created cluster of the same name.
	c.Stop()

	// Find and delete the kubeconfig file that contained this context.
	// If it contains other contexts still registered (different Cluster
	// objects), strip just our context from the YAML; if it's the last
	// context, unlink the file.
	if err := m.removeFromImportedFile(name); err != nil {
		m.logger.Warn("removed cluster from manager but failed to clean up disk file",
			zap.String("cluster", name), zap.Error(err))
	}
	return nil
}

// Disconnect tears down running informers for the named cluster and marks
// it as paused. The cluster stays registered (its kubeconfig stays on
// disk, the entry stays in the picker) so Connect() can re-enable it
// without re-importing. Idempotent on an already-paused cluster.
func (m *Manager) Disconnect(name string) error {
	m.mu.RLock()
	c, ok := m.clusters[name]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("unknown cluster %q", name)
	}
	c.Pause()
	return nil
}

// Connect is the inverse of Disconnect — flips the cluster back to active
// AND issues an immediate connectivity probe so the caller can return a
// `connected: true` ClusterInfo on the same HTTP turnaround. Without the
// sync probe the dot in the cluster picker stayed grey for up to 15 s
// after Reconnect, looking like the operation had failed.
func (m *Manager) Connect(ctx context.Context, name string) error {
	m.mu.RLock()
	c, ok := m.clusters[name]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("unknown cluster %q", name)
	}
	c.Resume(ctx)
	return nil
}

// SetCurrent updates the default cluster (in-memory only).
func (m *Manager) SetCurrent(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.clusters[name]; !ok {
		return fmt.Errorf("unknown cluster %q", name)
	}
	m.current = name
	return nil
}

// Wait blocks until every Cluster has stopped its informers.
func (m *Manager) Wait() {
	m.mu.RLock()
	for _, c := range m.clusters {
		c.Stop()
	}
	m.mu.RUnlock()
	m.wg.Wait()
}

// NewManagerForIdentity creates a Manager that owns ONLY the given
// identity's imported kubeconfigs — no host ~/.kube/config, no in-cluster
// credentials. The Registry calls this lazily, once per identity, on the
// first request from that browser/SSO user.
//
// `adoptLegacy`, when true, also loads the legacy ~/.k8s-view/imported/
// directory (the pre-multi-device location). The Registry sets this for the
// FIRST identity to visit after upgrade, so the existing user's clusters
// follow them into the new per-device world without manual re-import.
func NewManagerForIdentity(ctx context.Context, cfg *config.Config, logger *zap.Logger, identityID string, adoptLegacy bool) (*Manager, error) {
	if identityID == "" {
		return nil, fmt.Errorf("NewManagerForIdentity: empty identityID")
	}
	m := &Manager{
		cfg:        cfg,
		logger:     logger.With(zap.String("identity", identityID)),
		rootCtx:    ctx,
		clusters:   make(map[string]*Cluster),
		IdentityID: identityID,
	}

	// Per-identity imports first — these are the "primary" set this device
	// has been working with.
	m.LoadImported(ctx)

	// Legacy adoption: copy/load the host's pre-upgrade imported dir as if
	// it had been imported by this identity. Done by *loading* the YAMLs
	// into the per-identity directory; the legacy dir itself is left intact
	// so a fresh re-install re-discovers it (defensive: never delete
	// anything users might still want).
	if adoptLegacy {
		m.adoptLegacyImports(ctx)
	}

	if len(m.clusters) == 0 {
		m.logger.Info("identity manager ready",
			zap.Int("clusters", 0))
		return m, nil
	}

	// Pick a sensible default — the first cluster in alphabetical order.
	m.current = firstClusterName(m.order, m.clusters)
	m.logger.Info("identity manager ready",
		zap.Int("clusters", len(m.clusters)),
		zap.String("default", m.current))
	return m, nil
}

// adoptLegacyImports copies kubeconfigs from ~/.k8s-view/imported/ into
// this identity's directory, then loads them. The original files are
// preserved on disk — adoption is "copy in", not "move". Called by
// NewManagerForIdentity when adoptLegacy is true (i.e., this is the first
// device to visit after the multi-device upgrade).
func (m *Manager) adoptLegacyImports(ctx context.Context) {
	legacyDir, err := LegacyImportedDir()
	if err != nil {
		return
	}
	entries, err := os.ReadDir(legacyDir)
	if err != nil {
		return
	}
	targetDir, err := m.importedDir()
	if err != nil {
		return
	}
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		m.logger.Warn("legacy adoption: mkdir failed", zap.String("dir", targetDir), zap.Error(err))
		return
	}
	adopted := 0
	for _, e := range entries {
		if e.IsDir() || !isYAMLFile(e.Name()) {
			continue
		}
		src := filepath.Join(legacyDir, e.Name())
		dst := filepath.Join(targetDir, e.Name())
		if _, err := os.Stat(dst); err == nil {
			continue // already adopted on a previous startup
		}
		data, err := os.ReadFile(src)
		if err != nil {
			m.logger.Warn("legacy adoption: read failed", zap.String("src", src), zap.Error(err))
			continue
		}
		if err := os.WriteFile(dst, data, 0o600); err != nil {
			m.logger.Warn("legacy adoption: write failed", zap.String("dst", dst), zap.Error(err))
			continue
		}
		adopted++
	}
	if adopted > 0 {
		m.logger.Info("adopted legacy kubeconfigs into identity",
			zap.Int("count", adopted),
			zap.String("from", legacyDir),
			zap.String("to", targetDir))
		// Reload from the per-identity directory so the freshly-adopted
		// files become live clusters in this manager.
		m.LoadImported(ctx)
	}
}
