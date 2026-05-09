package clusters

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"go.uber.org/zap"

	"github.com/k8s-view/k8s-view/internal/config"
)

// Registry resolves the per-identity Manager for an HTTP request.
//
// Multi-device mode (the default): each device cookie / SSO user gets its
// own Manager, lazy-created on first access. Each Manager holds the
// identity's imported kubeconfigs only — there is no shared cluster pool.
//
// Special cases:
//   - cfg.InCluster == true: a single shared Manager is used for everyone,
//     because in-cluster credentials are inherently shared (the pod has one
//     identity to the apiserver, regardless of who's looking).
//   - The very first identity to request after upgrade also adopts the
//     legacy ~/.k8s-view/imported/ contents so existing users don't lose
//     their clusters. We track this via an on-disk sentinel file so the
//     adoption fires exactly once across server restarts.
type Registry struct {
	cfg     *config.Config
	logger  *zap.Logger
	rootCtx context.Context

	mu        sync.Mutex
	managers  map[string]*Manager
	inCluster *Manager // set when cfg.InCluster is true; shared across requests

	legacyAdopted bool // mirror of the on-disk sentinel
}

// NewRegistry constructs the registry. If InCluster is set, it creates the
// single shared manager up front; otherwise it just allocates the cache and
// defers manager creation to the first request per identity.
func NewRegistry(ctx context.Context, cfg *config.Config, logger *zap.Logger) (*Registry, error) {
	r := &Registry{
		cfg:      cfg,
		logger:   logger,
		rootCtx:  ctx,
		managers: make(map[string]*Manager),
	}
	if cfg != nil && cfg.InCluster {
		m, err := NewManager(ctx, cfg, logger)
		if err != nil {
			return nil, err
		}
		r.inCluster = m
	}
	r.legacyAdopted = legacyAdoptionSentinelExists()
	return r, nil
}

// For returns the Manager that should serve the given identity's request.
// Lazily constructs a new Manager (and persists the legacy-adopted sentinel
// for the first identity to visit). Safe for concurrent callers.
func (r *Registry) For(identityID string) (*Manager, error) {
	if r.inCluster != nil {
		// In-cluster: everyone shares the single Manager bound to the pod's
		// service account. Per-device isolation isn't possible — there's
		// only one set of credentials available to the binary.
		return r.inCluster, nil
	}
	if identityID == "" {
		return nil, errors.New("registry: empty identity")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if m, ok := r.managers[identityID]; ok {
		return m, nil
	}

	adoptLegacy := !r.legacyAdopted
	m, err := NewManagerForIdentity(r.rootCtx, r.cfg, r.logger, identityID, adoptLegacy)
	if err != nil {
		return nil, err
	}
	r.managers[identityID] = m

	if adoptLegacy {
		// Mark the sentinel BEFORE releasing the mutex so a parallel
		// request for a different identity won't also try to adopt.
		if err := writeLegacyAdoptionSentinel(identityID); err != nil {
			r.logger.Warn("failed to write legacy-adoption sentinel; legacy may be re-adopted on next visit",
				zap.Error(err))
		}
		r.legacyAdopted = true
	}

	return m, nil
}

// Wait stops every per-identity Manager. Called on shutdown.
func (r *Registry) Wait() {
	r.mu.Lock()
	managers := make([]*Manager, 0, len(r.managers))
	for _, m := range r.managers {
		managers = append(managers, m)
	}
	if r.inCluster != nil {
		managers = append(managers, r.inCluster)
	}
	r.mu.Unlock()
	for _, m := range managers {
		m.Wait()
	}
}

// --- legacy-adoption sentinel ---------------------------------------

// legacyAdoptionSentinelPath returns ~/.k8s-view/.legacy-adopted. The file
// records the identity that absorbed the pre-multi-device imported/ dir,
// so subsequent restarts know not to adopt again into a different identity.
func legacyAdoptionSentinelPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".k8s-view", ".legacy-adopted"), nil
}

func legacyAdoptionSentinelExists() bool {
	p, err := legacyAdoptionSentinelPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func writeLegacyAdoptionSentinel(identityID string) error {
	p, err := legacyAdoptionSentinelPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(identityID+"\n"), 0o600)
}
