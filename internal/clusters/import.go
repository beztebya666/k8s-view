package clusters

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"go.uber.org/zap"
	"k8s.io/client-go/tools/clientcmd"
)

// LegacyImportedDir is the pre-multi-device location of imported kubeconfigs:
// ~/.k8s-view/imported/. It still resolves so the Registry can adopt its
// contents into the first device that visits after upgrade. New writes go to
// the per-identity path returned by Manager.importedDir().
func LegacyImportedDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".k8s-view", "imported"), nil
}

// PerIdentityImportedDir returns ~/.k8s-view/devices/<identityID>/imported/.
// Each browser (or SSO-authenticated user) gets its own directory; the
// identity ID is opaque to disk — we just use it as a directory name. The
// directory is *not* created here; callers MkdirAll on demand.
func PerIdentityImportedDir(identityID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".k8s-view", "devices", identityID, "imported"), nil
}

// importedDir returns the directory this Manager writes new imports to. When
// IdentityID is empty (legacy single-device path, e.g. --in-cluster), we
// fall back to the legacy location so existing setups keep working.
func (m *Manager) importedDir() (string, error) {
	if m.IdentityID == "" {
		return LegacyImportedDir()
	}
	return PerIdentityImportedDir(m.IdentityID)
}

// LoadImported reads every kubeconfig file under the manager's imported
// directory and registers its contexts as Clusters. Errors per-file are
// logged but do not abort the rest. Idempotent — duplicate context names
// get a numeric suffix.
func (m *Manager) LoadImported(ctx context.Context) {
	dir, err := m.importedDir()
	if err != nil {
		m.logger.Warn("home dir lookup failed", zap.Error(err))
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			m.logger.Warn("imported kubeconfigs dir unreadable", zap.String("path", dir), zap.Error(err))
		}
		return
	}
	for _, e := range entries {
		if e.IsDir() || !isYAMLFile(e.Name()) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			m.logger.Warn("failed to read imported kubeconfig", zap.String("path", path), zap.Error(err))
			continue
		}
		added, err := m.addContextsFromYAML(data, path)
		if err != nil {
			m.logger.Warn("failed to load imported kubeconfig", zap.String("path", path), zap.Error(err))
			continue
		}
		m.logger.Info("loaded imported kubeconfig",
			zap.String("path", path),
			zap.Strings("contexts", added))
	}
}

// ImportKubeconfig parses the YAML payload, registers each context as a
// Cluster, and (when `persist` is true) writes the YAML to the imported
// directory. Returns the names that were actually added — duplicates are
// renamed to `<name>-2`, `<name>-3`, ... before being added.
func (m *Manager) ImportKubeconfig(_ context.Context, name string, yaml []byte, persist bool) ([]string, error) {
	added, err := m.addContextsFromYAML(yaml, "<inline import>")
	if err != nil {
		return nil, err
	}
	if !persist || len(added) == 0 {
		return added, nil
	}
	dir, err := m.importedDir()
	if err != nil {
		return added, fmt.Errorf("imported dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return added, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	safe := sanitizeFilename(strings.TrimSuffix(name, ".yaml"))
	if safe == "" {
		safe = sanitizeFilename(added[0])
	}
	if safe == "" {
		safe = "imported"
	}
	path := uniquePath(dir, safe+".yaml")
	if err := os.WriteFile(path, yaml, 0o600); err != nil {
		return added, fmt.Errorf("write %s: %w", path, err)
	}
	m.logger.Info("imported kubeconfig persisted",
		zap.String("path", path),
		zap.Strings("contexts", added))
	return added, nil
}

func (m *Manager) addContextsFromYAML(data []byte, sourceLabel string) ([]string, error) {
	cfg, err := clientcmd.Load(data)
	if err != nil {
		return nil, fmt.Errorf("parse kubeconfig: %w", err)
	}
	if len(cfg.Contexts) == 0 {
		return nil, errors.New("kubeconfig has no contexts")
	}
	names := make([]string, 0, len(cfg.Contexts))
	for ctxName := range cfg.Contexts {
		names = append(names, ctxName)
	}
	sort.Strings(names)

	m.mu.Lock()
	defer m.mu.Unlock()

	added := make([]string, 0, len(names))
	for _, ctxName := range names {
		// De-dupe across every cluster the manager already knows about.
		assigned := ctxName
		for i := 2; ; i++ {
			if _, exists := m.clusters[assigned]; !exists {
				break
			}
			assigned = fmt.Sprintf("%s-%d", ctxName, i)
		}

		clientCfg := clientcmd.NewNonInteractiveClientConfig(
			*cfg, ctxName, &clientcmd.ConfigOverrides{}, nil,
		)
		rc, err := clientCfg.ClientConfig()
		if err != nil {
			m.logger.Warn("failed to build rest.Config from import",
				zap.String("source", sourceLabel),
				zap.String("context", ctxName),
				zap.Error(err))
			continue
		}
		tuneRESTConfig(rc)
		c, err := newCluster(m.rootCtx, assigned, rc, m.logger.With(zap.String("cluster", assigned)))
		if err != nil {
			m.logger.Warn("imported cluster init failed",
				zap.String("source", sourceLabel),
				zap.String("context", ctxName),
				zap.Error(err))
			continue
		}
		m.clusters[assigned] = c
		m.order = append(m.order, assigned)
		added = append(added, assigned)
	}
	sort.Strings(m.order)
	return added, nil
}

// removeFromImportedFile finds the kubeconfig YAML in the identity's
// imported dir that defined `ctxName` and either:
//   1. unlinks the file when this was its only context, or
//   2. rewrites the file with that context (and its referenced cluster +
//      user) stripped, when other contexts in the same file are still in
//      use elsewhere in the manager.
//
// The "other contexts still in use" check matters because Import dedupes
// duplicate context names (`default` → `default-2`); two clusters in the
// manager can therefore legitimately share one kubeconfig file even
// though their names differ.
func (m *Manager) removeFromImportedFile(ctxName string) error {
	dir, err := m.importedDir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !isYAMLFile(e.Name()) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		cfg, err := clientcmd.Load(data)
		if err != nil {
			continue
		}
		if _, has := cfg.Contexts[ctxName]; !has {
			continue
		}
		// Found the source file. Decide whether to unlink or rewrite.
		ctx := cfg.Contexts[ctxName]
		clusterName := ""
		userName := ""
		if ctx != nil {
			clusterName = ctx.Cluster
			userName = ctx.AuthInfo
		}
		if len(cfg.Contexts) <= 1 {
			return os.Remove(path)
		}
		// Rewrite without this context. If the cluster/user are no longer
		// referenced by any remaining context, drop them too — keeps the
		// file from accumulating dead refs over multiple removes.
		delete(cfg.Contexts, ctxName)
		stillUsedCluster, stillUsedUser := false, false
		for _, c := range cfg.Contexts {
			if c == nil {
				continue
			}
			if clusterName != "" && c.Cluster == clusterName {
				stillUsedCluster = true
			}
			if userName != "" && c.AuthInfo == userName {
				stillUsedUser = true
			}
		}
		if !stillUsedCluster {
			delete(cfg.Clusters, clusterName)
		}
		if !stillUsedUser {
			delete(cfg.AuthInfos, userName)
		}
		if cfg.CurrentContext == ctxName {
			cfg.CurrentContext = ""
		}
		out, err := clientcmd.Write(*cfg)
		if err != nil {
			return err
		}
		return os.WriteFile(path, out, 0o600)
	}
	// Not found in any file — nothing to clean up.
	return nil
}

var unsafeFilenameChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func sanitizeFilename(s string) string {
	s = unsafeFilenameChars.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-.")
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

func uniquePath(dir, base string) string {
	candidate := filepath.Join(dir, base)
	if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
		return candidate
	}
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 2; i < 10000; i++ {
		c := filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		if _, err := os.Stat(c); errors.Is(err, os.ErrNotExist) {
			return c
		}
	}
	return candidate
}

func isYAMLFile(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, ".yaml") || strings.HasSuffix(n, ".yml") || strings.HasSuffix(n, ".kubeconfig")
}
