package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"
)

// DeviceCookieName — the cookie that identifies a browser. Long-lived,
// HttpOnly so JS / XSS can't read it, SameSite=Lax so it travels on top-level
// navigations but not on cross-site requests. Secure flag is set when the
// request arrived over HTTPS — local dev over plain HTTP still works.
const DeviceCookieName = "kv_device"

// DeviceCookieMaxAge — 1 year. Effectively "forever" for a browser that
// isn't being wiped. Re-issued (sliding) on every successful Identify so
// active users never see their kubeconfigs disappear, while inactive
// browsers age out and their data becomes orphan (cleanable later via a
// background sweep — out of scope for now).
const DeviceCookieMaxAge = 365 * 24 * time.Hour

// DeviceCookieProvider issues and reads the kv_device cookie. This is the
// default and (in the standard install) only provider — no login wall, no
// passwords, no setup. Each browser gets a stable opaque ID on first visit.
type DeviceCookieProvider struct {
	// SecureCookies forces the Secure flag even on plain-HTTP requests. Set
	// it to true when running behind a TLS-terminating reverse proxy that
	// forwards as plain HTTP. Defaults to false (auto-detect from the
	// request scheme).
	SecureCookies bool
}

func NewDeviceCookieProvider() *DeviceCookieProvider {
	return &DeviceCookieProvider{}
}

// Identify reads the device cookie from the request, or mints a fresh one
// if absent. Always succeeds — anonymous browsers are valid actors here.
// Sliding refresh: every Identify rewrites the cookie with a fresh
// expiration so an active session never times out.
func (p *DeviceCookieProvider) Identify(w http.ResponseWriter, r *http.Request) (Identity, error) {
	id, ok := readDeviceCookie(r)
	if !ok {
		id = mintDeviceID()
	}
	p.writeCookie(w, r, id)
	return Identity{ID: id, Kind: "device"}, nil
}

func readDeviceCookie(r *http.Request) (string, bool) {
	c, err := r.Cookie(DeviceCookieName)
	if err != nil || c == nil {
		return "", false
	}
	v := strings.TrimSpace(c.Value)
	// Defensive: reject obviously-corrupt values so a tampered cookie can't
	// land us with weird filesystem characters under ~/.k8s-view/devices/.
	if !validDeviceID(v) {
		return "", false
	}
	return v, true
}

func (p *DeviceCookieProvider) writeCookie(w http.ResponseWriter, r *http.Request, id string) {
	secure := p.SecureCookies || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     DeviceCookieName,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(DeviceCookieMaxAge.Seconds()),
	})
}

// devicePrefix gives the on-disk directory + log lines an obvious provenance
// hint (`dev_` for device, vs `oidc_`/`ldap_` later). Keeps mixed-provider
// installs trivially debuggable just by looking at the directory name.
const devicePrefix = "dev_"

func mintDeviceID() string {
	var raw [24]byte
	_, err := rand.Read(raw[:])
	if err != nil {
		// crypto/rand failure on a desktop OS is essentially impossible;
		// panic is the right call rather than emitting a guessable ID.
		panic("auth: crypto/rand.Read failed: " + err.Error())
	}
	return devicePrefix + base64.RawURLEncoding.EncodeToString(raw[:])
}

// validDeviceID accepts only the shape we ourselves mint: prefix + base64url.
// Lets the cookie value safely double as a directory name without needing
// to escape anything.
func validDeviceID(v string) bool {
	if !strings.HasPrefix(v, devicePrefix) {
		return false
	}
	body := v[len(devicePrefix):]
	if len(body) == 0 || len(body) > 128 {
		return false
	}
	for i := 0; i < len(body); i++ {
		c := body[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}

// AdoptDeviceID writes the given ID as the device cookie on this response.
// Used by the "restore device" flow in Settings — paste the device ID from
// another browser, the server adopts it, and the user's saved kubeconfigs
// reappear. Returns ErrInvalidDeviceID if the value isn't shaped like an ID
// we ourselves would mint (rejecting arbitrary user input).
func (p *DeviceCookieProvider) AdoptDeviceID(w http.ResponseWriter, r *http.Request, id string) error {
	id = strings.TrimSpace(id)
	if !validDeviceID(id) {
		return ErrInvalidDeviceID
	}
	p.writeCookie(w, r, id)
	return nil
}

// ErrInvalidDeviceID is returned by AdoptDeviceID when the supplied value is
// not shaped like a k8s-view device cookie (wrong prefix, wrong charset,
// out-of-range length).
var ErrInvalidDeviceID = errors.New("auth: invalid device id")
