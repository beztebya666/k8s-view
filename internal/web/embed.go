// Package web embeds the built React frontend so the binary serves the UI
// without depending on any external static-asset directory.
//
// During development the frontend ships an SPA shell at frontend/dist/. The
// `make frontend` target produces it via Vite. If the directory is missing
// (e.g. the binary was built without running `make frontend` first), we
// fall back to a tiny inline page that still lets the user use the API.
package web

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

//go:embed all:dist
var distFS embed.FS

// Handler returns the HTTP handler that serves the frontend SPA. It rewrites
// unknown deep links to /index.html so client-side routing keeps working
// after a hard reload.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return http.HandlerFunc(fallback)
	}
	indexBytes, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		return http.HandlerFunc(fallback)
	}
	startup := time.Now()
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" || path == "index.html" {
			serveIndex(w, r, indexBytes, startup)
			return
		}
		if _, err := fs.Stat(sub, path); err == nil {
			if strings.HasPrefix(path, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		// SPA deep link → serve index.html and let the React Router handle it.
		serveIndex(w, r, indexBytes, startup)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, body []byte, startup time.Time) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", startup, bytes.NewReader(body))
}

func fallback(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(`<!doctype html>
<html><head><meta charset="utf-8"><title>k8s-view</title></head>
<body style="font-family:system-ui;background:#0b0d10;color:#e6e6e6;display:flex;
min-height:100vh;align-items:center;justify-content:center;text-align:center">
  <div>
    <h1 style="font-weight:300;font-size:32px;margin:0">k8s-view</h1>
    <p style="opacity:.6">The frontend was not built into this binary.</p>
    <p style="opacity:.6">Run <code>make frontend</code> and rebuild, or hit the API at <code>/api/v1/healthz</code>.</p>
  </div>
</body></html>`))
}
