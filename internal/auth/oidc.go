package auth

import (
	"errors"
	"net/http"
)

// OIDCConfig holds the runtime configuration for an OIDC provider. Wired
// via environment variables in cmd/k8sview/main.go; when Enabled is false
// (the default), no OIDC routes are mounted and the provider isn't added
// to the Composite chain.
//
// This file is intentionally a *stub*: the structure is in place so SSO can
// be plugged in without disrupting the device-cookie path, but no real
// OIDC handshake happens yet. Wiring real go-oidc / oauth2 client code is
// deferred to a follow-up tagged "phase 2" — the explicit ENV flag means
// nothing accidentally activates a half-implemented login flow.
type OIDCConfig struct {
	Enabled         bool
	IssuerURL       string
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	Scopes          []string // e.g. {"openid","profile","email"}
	AllowedDomains  []string // optional email-domain allowlist
	AdminGroupClaim string   // optional group name that grants admin
}

// OIDCProvider is the placeholder implementation. Identify always returns
// ErrUnauthenticated so the Composite falls through to the next provider
// (typically DeviceCookieProvider). When phase 2 lands, this is where the
// session-cookie lookup + IDToken validation will live.
type OIDCProvider struct {
	cfg OIDCConfig
}

// NewOIDCProvider constructs a provider only when cfg.Enabled is true.
// Returns nil otherwise so callers can safely splat the result into a
// Composite without an Enabled check at the call site.
func NewOIDCProvider(cfg OIDCConfig) *OIDCProvider {
	if !cfg.Enabled {
		return nil
	}
	return &OIDCProvider{cfg: cfg}
}

func (p *OIDCProvider) Identify(_ http.ResponseWriter, _ *http.Request) (Identity, error) {
	// Stub: return ErrUnauthenticated so the Composite tries the next
	// provider. Phase 2 will read a "kv_oidc" session cookie, validate the
	// stored IDToken, and return Identity{ID: "oidc_"+sub, Kind: "oidc"}.
	return Identity{}, ErrUnauthenticated
}

// ErrOIDCNotImplemented is returned by route handlers that get hit before
// phase 2 wires the real flow. The router only mounts those routes when
// cfg.Enabled is true, so reaching this means env flags asked for OIDC but
// the binary doesn't have it — fail loudly rather than silently fall back.
var ErrOIDCNotImplemented = errors.New("auth/oidc: OIDC support is not yet implemented (stub)")
