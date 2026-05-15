package clusters

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"go.uber.org/zap"
)

// kubeconfigYAML returns a minimal but valid kubeconfig with the given
// context name pointing at a fake apiserver. Just enough to flow through
// clientcmd.Load and clientcmd.NewNonInteractiveClientConfig — we don't
// actually connect to anything in these tests.
func kubeconfigYAML(ctxName string) string {
	return "" +
		"apiVersion: v1\n" +
		"kind: Config\n" +
		"clusters:\n" +
		"- name: fake\n" +
		"  cluster:\n" +
		"    server: https://127.0.0.1:65535\n" +
		"    insecure-skip-tls-verify: true\n" +
		"users:\n" +
		"- name: fake-user\n" +
		"  user: {}\n" +
		"contexts:\n" +
		"- name: " + ctxName + "\n" +
		"  context:\n" +
		"    cluster: fake\n" +
		"    user: fake-user\n"
}

// newTestManager builds a Manager with an isolated importedDir backed by
// the test's t.TempDir, so concurrent test runs don't clobber each other
// and so we never touch ~/.k8s-view on the developer's machine.
func newTestManager(t *testing.T, dir string) *Manager {
	t.Helper()
	return &Manager{
		logger:     zap.NewNop(),
		rootCtx:    context.Background(),
		clusters:   make(map[string]*Cluster),
		IdentityID: "test-" + filepath.Base(dir),
	}
}

// withTempImportDir overrides where importedDir() resolves to by setting
// HOME to a temp directory. PerIdentityImportedDir() concatenates HOME →
// .k8s-view → devices → IdentityID → imported, so each test run gets an
// isolated path.
func withTempImportDir(t *testing.T) (dir string, cleanup func()) {
	t.Helper()
	home := t.TempDir()
	prev, hadPrev := os.LookupEnv("HOME")
	prevUser, hadPrevUser := os.LookupEnv("USERPROFILE")
	_ = os.Setenv("HOME", home)
	_ = os.Setenv("USERPROFILE", home) // os.UserHomeDir prefers USERPROFILE on Windows.
	return home, func() {
		if hadPrev {
			_ = os.Setenv("HOME", prev)
		} else {
			_ = os.Unsetenv("HOME")
		}
		if hadPrevUser {
			_ = os.Setenv("USERPROFILE", prevUser)
		} else {
			_ = os.Unsetenv("USERPROFILE")
		}
	}
}

// TestLoadImportedIsIdempotent verifies that calling LoadImported twice
// against the same directory adds each context once — no `-2` rename
// fan-out, no duplicate Cluster objects. This is the regression test for
// the "import not visible until restart" memory: the symptom (duplicates
// on second visit) only appeared once a second load was attempted.
func TestLoadImportedIsIdempotent(t *testing.T) {
	home, cleanup := withTempImportDir(t)
	defer cleanup()

	m := newTestManager(t, home)

	dir, err := m.importedDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	yamlPath := filepath.Join(dir, "test.yaml")
	if err := os.WriteFile(yamlPath, []byte(kubeconfigYAML("kubernetes-admin@kubernetes")), 0o600); err != nil {
		t.Fatal(err)
	}

	m.LoadImported(context.Background())
	m.LoadImported(context.Background())
	m.LoadImported(context.Background())

	if len(m.clusters) != 1 {
		t.Fatalf("expected exactly 1 cluster after repeated loads, got %d (names=%v)", len(m.clusters), m.order)
	}
	if _, ok := m.clusters["kubernetes-admin@kubernetes"]; !ok {
		t.Fatalf("expected cluster registered under decoded name, got order=%v", m.order)
	}
	if got := m.clusters["kubernetes-admin@kubernetes"].Origin(); got != OriginImported {
		t.Fatalf("origin tag missing: got %q want %q", got, OriginImported)
	}
}

// TestImportKubeconfigSetsCurrent — the first imported context on an
// empty manager auto-promotes to `current`. Saves the UI a redundant
// /select round-trip on the empty-state flow.
func TestImportKubeconfigSetsCurrent(t *testing.T) {
	home, cleanup := withTempImportDir(t)
	defer cleanup()

	m := newTestManager(t, home)
	added, err := m.ImportKubeconfig(context.Background(), "test", []byte(kubeconfigYAML("first@cluster")), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(added) != 1 || added[0] != "first@cluster" {
		t.Fatalf("unexpected import result: %v", added)
	}
	if m.Current() != "first@cluster" {
		t.Fatalf("current not auto-promoted: got %q", m.Current())
	}

	// Subsequent imports must NOT clobber the existing current pointer —
	// we only auto-promote when starting from empty.
	_, err = m.ImportKubeconfig(context.Background(), "second", []byte(kubeconfigYAML("second@cluster")), false)
	if err != nil {
		t.Fatal(err)
	}
	if m.Current() != "first@cluster" {
		t.Fatalf("current changed by second import: got %q", m.Current())
	}
}

// TestConcurrentLoadImportedIsSafe stresses the loadedFiles dedupe under
// concurrent callers — proves the lock around the map check is correct.
func TestConcurrentLoadImportedIsSafe(t *testing.T) {
	home, cleanup := withTempImportDir(t)
	defer cleanup()

	m := newTestManager(t, home)
	dir, err := m.importedDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.yaml"), []byte(kubeconfigYAML("a@x")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.yaml"), []byte(kubeconfigYAML("b@x")), 0o600); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.LoadImported(context.Background())
		}()
	}
	wg.Wait()

	if len(m.clusters) != 2 {
		t.Fatalf("concurrent LoadImported produced %d clusters, want 2 (order=%v)", len(m.clusters), m.order)
	}
}
