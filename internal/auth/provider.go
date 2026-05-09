// Package auth handles per-request identity for k8s-view.
//
// k8s-view does NOT have a username/password login wall. The default model is
// identical in spirit to mongostudio's connection-id pattern: a long-lived
// opaque cookie identifies the device, and per-device kubeconfigs are stored
// server-side under ~/.k8s-view/devices/<id>/imported/. Each browser is its
// own "tenant" — paste your kubeconfig once, leave, come back a week later,
// it's still there.
//
// The Provider interface is intentionally pluggable so SSO (OIDC) and LDAP
// can be layered later via env-gated configuration without disturbing the
// device-cookie path. When a Provider returns a non-empty Identity.Kind
// other than "device", the request is treated as an authenticated user
// session and the per-identity Manager registry serves their resources.
package auth

import (
	"context"
	"errors"
	"net/http"
)

// Identity is the resolved actor for a request. ID is the ONLY field
// downstream code uses to scope kubeconfigs and Manager state — it must
// be stable for the lifetime of the user (per-device cookie value, OIDC
// `sub`, LDAP UID, etc.). Treat it as opaque; never display it raw.
type Identity struct {
	// ID — stable per-actor key (e.g. "dev_<32-byte-base64>" for device,
	// "oidc_<sub>" for SSO, "ldap_<uid>" for LDAP). Used as the directory
	// name for kubeconfig storage and as the Manager-registry key.
	ID string
	// Kind tells UI/log code which provider issued this identity.
	Kind string // "device" | "oidc" | "ldap"
	// DisplayName is the human-friendly label, if known. Empty for anonymous
	// device identities.
	DisplayName string
}

// Provider resolves an Identity from an incoming HTTP request. Implementations
// may set cookies on the response (for example, the device-cookie provider
// issues a fresh cookie on first visit). Returning ErrUnauthenticated tells
// the middleware "I don't recognise this request" — the next provider in a
// Composite is tried; if none succeeds, the request is rejected.
type Provider interface {
	Identify(w http.ResponseWriter, r *http.Request) (Identity, error)
}

// ErrUnauthenticated is returned by a Provider that doesn't recognise the
// request. A Composite tries the next provider in line; the device-cookie
// provider is always last and never returns this error (it issues a cookie
// instead), so a Composite always resolves to *some* identity in practice.
var ErrUnauthenticated = errors.New("auth: unauthenticated")

// Composite chains providers — first non-error wins. The intended layout:
//
//	Composite{Providers: []Provider{oidcProvider, ldapProvider, deviceProvider}}
//
// SSO providers run first so an authenticated user sees their stuff
// regardless of which device they're on. The DeviceCookieProvider is always
// last so anonymous browsers still resolve to a stable per-device identity.
type Composite struct {
	Providers []Provider
}

func (c *Composite) Identify(w http.ResponseWriter, r *http.Request) (Identity, error) {
	for _, p := range c.Providers {
		id, err := p.Identify(w, r)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, ErrUnauthenticated) {
			return Identity{}, err
		}
	}
	return Identity{}, ErrUnauthenticated
}

// --- Request context helpers -----------------------------------------

type ctxKey struct{}

// WithIdentity attaches an Identity to the request context. Called by the
// middleware after Provider.Identify succeeds.
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// FromContext returns the Identity attached by the middleware. The bool is
// false when called outside the middleware chain (for example during server
// startup — cluster manager bootstrapping has no associated request).
func FromContext(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// MustFromContext panics if no identity is present. Use it in handlers that
// run AFTER the middleware (i.e. anything mounted under the auth chain) —
// the middleware guarantees an identity is attached before the handler runs.
func MustFromContext(ctx context.Context) Identity {
	id, ok := FromContext(ctx)
	if !ok {
		panic("auth.MustFromContext called outside middleware-protected handler")
	}
	return id
}
