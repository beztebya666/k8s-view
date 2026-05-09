package auth

import (
	"errors"
	"net/http"
)

// LDAPConfig holds the runtime configuration for an LDAP provider. Same
// shape contract as OIDCConfig — Enabled is the only flag callers need to
// gate on. Wired via env in cmd/k8sview/main.go.
//
// Stub on purpose. Real bind+search lives in phase 3; this file keeps the
// type+interface in place so a future plug-in is a one-file addition rather
// than a Composite refactor.
type LDAPConfig struct {
	Enabled         bool
	URL             string // e.g. ldaps://ldap.example.com:636
	BindDN          string
	BindPassword    string
	UserSearchBase  string
	UserFilter      string // e.g. (uid=%s) or (sAMAccountName=%s)
	GroupSearchBase string
	GroupFilter     string
	AdminGroupDN    string
	StartTLS        bool
}

// LDAPProvider is the placeholder. Identify always returns
// ErrUnauthenticated so the Composite falls through to DeviceCookieProvider.
type LDAPProvider struct {
	cfg LDAPConfig
}

// NewLDAPProvider returns nil when cfg.Enabled is false so the call site can
// splat the result into a Composite without checking.
func NewLDAPProvider(cfg LDAPConfig) *LDAPProvider {
	if !cfg.Enabled {
		return nil
	}
	return &LDAPProvider{cfg: cfg}
}

func (p *LDAPProvider) Identify(_ http.ResponseWriter, _ *http.Request) (Identity, error) {
	return Identity{}, ErrUnauthenticated
}

// ErrLDAPNotImplemented mirrors ErrOIDCNotImplemented — surfaced when a
// future LDAP-only route is reached before phase 3 wires the real bind.
var ErrLDAPNotImplemented = errors.New("auth/ldap: LDAP support is not yet implemented (stub)")
