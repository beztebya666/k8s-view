// Package api wires HTTP routes to the cluster manager.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"go.uber.org/zap"

	"github.com/k8s-view/k8s-view/internal/auth"
	"github.com/k8s-view/k8s-view/internal/clusters"
	"github.com/k8s-view/k8s-view/internal/config"
)

// Deps is the bag of dependencies the API layer needs.
type Deps struct {
	Logger   *zap.Logger
	Registry *clusters.Registry
	// AuthProvider resolves the identity for each request. The router wraps
	// it in chi middleware that attaches the Identity to the request
	// context; handlers call h.managerFor(r) to get the right Manager.
	AuthProvider auth.Provider
	// Devices is exposed only so the /me endpoint can hand back the device
	// cookie value for the Settings page. nil unless the active provider
	// chain includes a DeviceCookieProvider.
	Devices  *auth.DeviceCookieProvider
	FrontEnd http.Handler
	Config   *config.Config
	Version  string
	Commit   string
}

// NewRouter assembles every handler.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	if d.Logger != nil {
		r.Use(requestLogger(d.Logger))
	}
	// No global timeout — log/exec/port-forward streams are long-lived.

	allowed := []string{"*"}
	if d.Config != nil && len(d.Config.AllowOrigins) > 0 {
		allowed = d.Config.AllowOrigins
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowed,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	if d.Config != nil && d.Config.BasicAuthUser != "" {
		r.Use(basicAuth(d.Config.BasicAuthUser, d.Config.BasicAuthPass))
	}

	// Identity middleware — resolves device cookie / SSO and attaches
	// auth.Identity to the request context. Always installed; with the
	// default DeviceCookieProvider it issues a fresh cookie on first visit
	// rather than rejecting, so the UX is mongostudio-style "open and use".
	if d.AuthProvider != nil {
		r.Use(auth.Middleware(d.AuthProvider))
	}

	h := &handlers{deps: d}

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/healthz", h.healthz)
		r.Get("/version", h.version)
		// Per-identity introspection — the Settings panel reads this to
		// show the device ID + provide the "restore on another browser"
		// flow. POST /me/adopt accepts a device ID and writes the cookie.
		r.Get("/me", h.whoAmI)
		r.Post("/me/adopt", h.adoptDevice)
		r.Get("/clusters", h.listClusters)
		r.Post("/clusters/import", h.importCluster)
		r.Get("/clusters/scan", h.scanKubeconfigs)
		r.Post("/clusters/{name}/select", h.selectCluster)
		r.Post("/clusters/{name}/disconnect", h.disconnectCluster)
		r.Post("/clusters/{name}/connect", h.connectCluster)
		r.Delete("/clusters/{name}", h.removeCluster)

		r.Route("/{cluster}", func(r chi.Router) {
			r.Get("/api-resources", h.apiResources)
			r.Get("/namespaces", h.listNamespaces)

			// Streaming WebSocket for live deltas.
			r.Get("/stream", h.stream)

			// Resource CRUD via dynamic client (cluster scope).
			r.Get("/resource/{group}/{version}/{resource}", h.listResource)
			r.Get("/resource/{group}/{version}/{resource}/{name}", h.getResource)
			r.Put("/resource/{group}/{version}/{resource}/{name}", h.applyResource)
			r.Delete("/resource/{group}/{version}/{resource}/{name}", h.deleteResource)

			// Namespaced.
			r.Get("/resource/{group}/{version}/{resource}/ns/{namespace}", h.listResource)
			r.Get("/resource/{group}/{version}/{resource}/ns/{namespace}/{name}", h.getResource)
			r.Put("/resource/{group}/{version}/{resource}/ns/{namespace}/{name}", h.applyResource)
			r.Delete("/resource/{group}/{version}/{resource}/ns/{namespace}/{name}", h.deleteResource)

			// Pod sub-resources.
			r.Get("/pods/{namespace}/{name}/logs", h.podLogs)
			r.Get("/pods/{namespace}/{name}/exec", h.podExec)
			r.Get("/pods/{namespace}/{name}/attach", h.podAttach)
			r.Get("/pods/{namespace}/{name}/portforward", h.podPortForward)
			r.Post("/pods/{namespace}/{name}/evict", h.evictPod)

			// Convenience actions.
			r.Post("/scale/{group}/{version}/{resource}/ns/{namespace}/{name}", h.scale)
			r.Post("/restart/{group}/{version}/{resource}/ns/{namespace}/{name}", h.restart)

			// Deployment rollout history + rollback. Deployment-only;
			// StatefulSet/DaemonSet revisions live in ControllerRevision and
			// would need a separate code path.
			r.Get("/rollouts/{namespace}/{name}", h.listRollouts)
			r.Post("/rollouts/{namespace}/{name}/rollback", h.rollbackDeployment)
			r.Post("/nodes/{name}/cordon", h.cordon)
			r.Post("/nodes/{name}/uncordon", h.uncordon)
			r.Post("/nodes/{name}/drain", h.drain)
			r.Post("/nodes/{name}/shell", h.nodeShell)
			r.Delete("/node-shell/{namespace}/{name}", h.nodeShellCleanup)
			r.Get("/events/{namespace}", h.eventsByNamespace)
			r.Get("/metrics/pods/{namespace}", h.podMetrics)
			r.Get("/metrics/nodes", h.nodeMetrics)

			// Prometheus auto-discovery + proxy. The frontend calls /info to
			// decide whether to display Prometheus-derived metrics, then uses
			// /query and /query_range for graphs and tables.
			r.Get("/prometheus/info", h.prometheusInfo)
			r.Get("/prometheus/query", h.prometheusQuery)
			r.Get("/prometheus/query_range", h.prometheusQueryRange)

			// Generic apply (server-side apply YAML upload).
			r.Post("/apply", h.serverSideApply)
		})
	})

	// Frontend (must be last because chi serves it as a fallback).
	if d.FrontEnd != nil {
		r.Handle("/*", d.FrontEnd)
	}
	return r
}

func basicAuth(user, pass string) func(http.Handler) http.Handler {
	expectedUser := []byte(user)
	expectedPass := []byte(pass)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotUser, gotPass, ok := r.BasicAuth()
			if !ok ||
				subtle.ConstantTimeCompare([]byte(gotUser), expectedUser) != 1 ||
				subtle.ConstantTimeCompare([]byte(gotPass), expectedPass) != 1 {
				w.Header().Set("WWW-Authenticate", `Basic realm="k8s-view"`)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{
		"error": err.Error(),
		"at":    time.Now().UTC().Format(time.RFC3339),
	})
}

func (h *handlers) writeError(w http.ResponseWriter, r *http.Request, status int, err error) {
	logger := h.deps.Logger
	if logger == nil {
		logger = zap.NewNop()
	}
	fields := []zap.Field{
		zap.String("request_id", middleware.GetReqID(r.Context())),
		zap.String("method", r.Method),
		zap.String("path", r.URL.Path),
		zap.String("cluster", chi.URLParam(r, "cluster")),
		zap.Int("status", status),
		zap.Error(err),
	}
	// 4xx is the client's fault — usually a stale browser tab pointing at a
	// removed cluster, an invalid resource name, or an RBAC denial. None of
	// those need an operator alert; keep them at Debug so the log volume
	// stays signal-shaped. 5xx (and anything weirder) still gets a Warn so
	// real backend faults remain visible.
	switch {
	case status >= 500:
		logger.Warn("api request failed", fields...)
	case status >= 400:
		logger.Debug("api request rejected", fields...)
	default:
		logger.Info("api request returned non-2xx", fields...)
	}
	writeError(w, status, err)
}

func requestLogger(logger *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)

			status := ww.Status()
			if status == 0 {
				status = http.StatusOK
			}
			fields := []zap.Field{
				zap.String("request_id", middleware.GetReqID(r.Context())),
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.Int("status", status),
				zap.Int("bytes", ww.BytesWritten()),
				zap.Duration("duration", time.Since(start)),
				zap.String("remote", r.RemoteAddr),
				zap.String("user_agent", r.UserAgent()),
			}
			if status >= 500 {
				logger.Warn("http request completed", fields...)
				return
			}
			if status >= 400 {
				logger.Info("http request completed", fields...)
				return
			}
			logger.Debug("http request completed", fields...)
		})
	}
}
