package api

import (
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
)

// urlParam returns the URL-decoded chi path parameter for `key`.
//
// chi captures path segments verbatim — so a browser-encoded `%40` arrives
// as `%40`, never as `@`. Domain identifiers (cluster names, namespaces,
// resource names) are stored in their canonical, decoded form, so a raw
// lookup always misses. This helper is the single chokepoint that decodes
// percent-escapes before any handler does a lookup. Every other site in
// the package goes through it; bare chi.URLParam is reserved for log fields
// where we want to record exactly what the browser sent.
//
// Edge cases:
//   - empty value (param not matched, or matched as empty): returned as is.
//   - malformed percent-escape (e.g. "%ZZ"): returned as empty string.
//     The handler then sees "" and surfaces a clean 404/400; the raw
//     encoded value is never forwarded to a Kubernetes lookup, so we
//     can't accidentally hit the apiserver with something invalid.
//
// Double-decode safety: chi v5 does not decode path params, so calling
// url.PathUnescape once here is exactly the right number of times. The
// helper is idempotent on already-decoded strings (no `%` → no-op) which
// makes accidental re-wrapping harmless.
func urlParam(r *http.Request, key string) string {
	v, _ := urlParamStrict(r, key)
	return v
}

// urlParamStrict is the explicit-error variant. Used by entry-point
// handlers that want to surface a 400 ("invalid percent-encoding") rather
// than a silent 404 when the browser sends a malformed path. Both helpers
// behave identically on well-formed input.
func urlParamStrict(r *http.Request, key string) (string, error) {
	raw := chi.URLParam(r, key)
	if raw == "" {
		return "", nil
	}
	return url.PathUnescape(raw)
}
