package auth

import (
	"errors"
	"net/http"
)

// Middleware wraps a chi handler chain. It runs the configured Provider on
// every request, attaches the resolved Identity to the request context, and
// rejects with 401 only if no provider could resolve an identity. With the
// default DeviceCookieProvider, this never rejects — anonymous browsers get
// a fresh device cookie on first visit.
//
// We deliberately allow a small allowlist of paths to skip identification
// (notably /api/v1/healthz which is intended for plain liveness probes that
// shouldn't hand out cookies). Everything else flows through.
func Middleware(provider Provider) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isPublicPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			id, err := provider.Identify(w, r)
			if err != nil {
				if errors.Is(err, ErrUnauthenticated) {
					http.Error(w, "unauthenticated", http.StatusUnauthorized)
					return
				}
				http.Error(w, "auth error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			ctx := WithIdentity(r.Context(), id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// isPublicPath returns true for endpoints that intentionally skip identity
// resolution — used for liveness probes and similar low-trust endpoints.
// The list is deliberately tiny: anything user-facing should go through
// the middleware so per-identity isolation isn't bypassable.
func isPublicPath(path string) bool {
	switch path {
	case "/api/v1/healthz", "/api/v1/version":
		return true
	}
	return false
}
