package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestURLParamDecodes exercises every realistic percent-escape we expect
// to see in a chi-captured segment for k8s-view. The matrix mirrors the
// shape of real cluster / namespace / resource names plus a handful of
// adversarial cases (malformed escapes, ASCII control bytes).
func TestURLParamDecodes(t *testing.T) {
	cases := []struct {
		name string
		raw  string // what chi captured (i.e. what the browser put in the path)
		want string
	}{
		{"plain", "default", "default"},
		{"empty", "", ""},
		{"at-sign", "kubernetes-admin%40kubernetes", "kubernetes-admin@kubernetes"},
		{"dot-and-dashes", "my.cluster-prod", "my.cluster-prod"},
		{"slash-encoded", "team%2Fa", "team/a"},
		{"plus-literal", "a+b", "a+b"}, // PathUnescape preserves '+', unlike QueryUnescape
		{"percent-literal", "100%25", "100%"},
		{"colon", "host%3A6443", "host:6443"},
		{"space-encoded", "ns%20one", "ns one"},
		{"unicode-cjk", "%E4%B8%AD%E6%96%87", "中文"},
		{"emoji", "%F0%9F%9A%80", "🚀"},
		{"already-decoded-noop", "kubernetes-admin@kubernetes", "kubernetes-admin@kubernetes"},
		{"malformed-zz", "bad%ZZvalue", ""},   // url.PathUnescape returns err → empty
		{"malformed-trailing", "trailing%", ""}, // truncated escape → empty
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/dummy", nil)
			req = req.WithContext(withChiParam(req.Context(), "cluster", tc.raw))
			if got := urlParam(req, "cluster"); got != tc.want {
				t.Fatalf("urlParam(cluster=%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestURLParamStrict surfaces the malformed-escape distinction the
// non-strict helper hides: bad input returns an explicit error rather
// than a silent empty string.
func TestURLParamStrict(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/dummy", nil)
	req = req.WithContext(withChiParam(req.Context(), "cluster", "kubernetes-admin%40kubernetes"))
	v, err := urlParamStrict(req, "cluster")
	if err != nil {
		t.Fatalf("strict decode of %%40 returned error: %v", err)
	}
	if v != "kubernetes-admin@kubernetes" {
		t.Fatalf("strict decode got %q", v)
	}

	req = httptest.NewRequest(http.MethodGet, "/dummy", nil)
	req = req.WithContext(withChiParam(req.Context(), "cluster", "bad%ZZ"))
	if _, err := urlParamStrict(req, "cluster"); err == nil {
		t.Fatal("expected error on malformed escape, got nil")
	}
}

// TestURLParamRouterEndToEnd verifies that when chi actually routes a
// request, the helper sees the param the browser sent (percent-escapes
// and all) and decodes it back to the canonical form a registry would
// store. This is the test that would have caught the original bug —
// curl sends `@` literal, the browser sends `%40`, both must end up as
// `@` inside the handler.
func TestURLParamRouterEndToEnd(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/v1/{cluster}/namespaces", func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(urlParam(req, "cluster")))
	})

	cases := map[string]string{
		"/api/v1/kubernetes-admin@kubernetes/namespaces":   "kubernetes-admin@kubernetes",
		"/api/v1/kubernetes-admin%40kubernetes/namespaces": "kubernetes-admin@kubernetes",
		"/api/v1/team%2Fa/namespaces":                      "team/a",
		"/api/v1/%E4%B8%AD%E6%96%87/namespaces":            "中文",
	}
	for path, want := range cases {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, path, nil)
			r.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if rec.Body.String() != want {
				t.Fatalf("got %q, want %q", rec.Body.String(), want)
			}
		})
	}
}

// withChiParam injects a single chi path param into a request context the
// way chi's mux would after a successful match. Used by the unit-level
// tests above so they don't have to spin up a router for every case.
func withChiParam(ctx context.Context, key, value string) context.Context {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return context.WithValue(ctx, chi.RouteCtxKey, rctx)
}
