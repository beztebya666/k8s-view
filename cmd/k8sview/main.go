// Package main is the entrypoint for the k8s-view server.
//
// k8s-view is a single-binary Kubernetes dashboard. The same binary serves
// the embedded React frontend, the REST API, and the streaming WebSocket
// channel that pushes live deltas from the cluster to the browser.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/k8s-view/k8s-view/internal/api"
	"github.com/k8s-view/k8s-view/internal/auth"
	"github.com/k8s-view/k8s-view/internal/clusters"
	"github.com/k8s-view/k8s-view/internal/config"
	"github.com/k8s-view/k8s-view/internal/log"
	"github.com/k8s-view/k8s-view/internal/web"
)

var (
	version = "0.4.0"
	commit  = "dev"
)

func main() {
	cfg := config.FromFlags()
	flag.Parse()

	logger := log.New(cfg.LogLevel)
	defer logger.Sync() //nolint:errcheck

	logger.Info("starting k8s-view",
		zap.String("version", version),
		zap.String("commit", commit),
		zap.String("listen", cfg.ListenAddr),
		zap.String("kubeconfig", cfg.Kubeconfig),
		zap.Bool("in_cluster", cfg.InCluster),
	)

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	registry, err := clusters.NewRegistry(rootCtx, cfg, logger)
	if err != nil {
		logger.Fatal("failed to initialise cluster registry", zap.Error(err))
	}

	// Identity provider chain: SSO providers (when env-enabled) try first,
	// device cookie always last so anonymous browsers get a stable per-
	// device identity. NewOIDCProvider/NewLDAPProvider return nil unless
	// their env-flagged config has Enabled=true, so the slice stays slim
	// in the default install.
	devices := auth.NewDeviceCookieProvider()
	composite := &auth.Composite{}
	if oidc := auth.NewOIDCProvider(loadOIDCConfig()); oidc != nil {
		composite.Providers = append(composite.Providers, oidc)
		logger.Info("OIDC provider enabled (stub — phase 2 wiring pending)")
	}
	if ldap := auth.NewLDAPProvider(loadLDAPConfig()); ldap != nil {
		composite.Providers = append(composite.Providers, ldap)
		logger.Info("LDAP provider enabled (stub — phase 3 wiring pending)")
	}
	composite.Providers = append(composite.Providers, devices)

	router := api.NewRouter(api.Deps{
		Logger:       logger,
		Registry:     registry,
		AuthProvider: composite,
		Devices:      devices,
		FrontEnd:     web.Handler(),
		Config:       cfg,
		Version:      version,
		Commit:       commit,
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 15 * time.Second,
		// No write timeout: WebSocket and log/exec streams are long-lived.
	}

	go func() {
		logger.Info("listening", zap.String("addr", cfg.ListenAddr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("http server failed", zap.Error(err))
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	sig := <-stop
	logger.Info("shutdown signal received", zap.String("signal", sig.String()))

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http server shutdown returned error", zap.Error(err))
	}
	cancel()
	registry.Wait()
	fmt.Fprintln(os.Stderr, "bye")
}

// loadOIDCConfig reads K8SVIEW_OIDC_* env vars. Returns Enabled=false when
// the toggle env var isn't set, which makes NewOIDCProvider return nil.
// Real env wiring lives here so adding a new env var is one obvious diff.
func loadOIDCConfig() auth.OIDCConfig {
	enabled := os.Getenv("K8SVIEW_OIDC_ENABLED") == "true"
	return auth.OIDCConfig{
		Enabled:         enabled,
		IssuerURL:       os.Getenv("K8SVIEW_OIDC_ISSUER"),
		ClientID:        os.Getenv("K8SVIEW_OIDC_CLIENT_ID"),
		ClientSecret:    os.Getenv("K8SVIEW_OIDC_CLIENT_SECRET"),
		RedirectURL:     os.Getenv("K8SVIEW_OIDC_REDIRECT_URI"),
		Scopes:          splitCSV(os.Getenv("K8SVIEW_OIDC_SCOPES")),
		AllowedDomains:  splitCSV(os.Getenv("K8SVIEW_OIDC_ALLOWED_DOMAINS")),
		AdminGroupClaim: os.Getenv("K8SVIEW_OIDC_ADMIN_GROUP"),
	}
}

func loadLDAPConfig() auth.LDAPConfig {
	enabled := os.Getenv("K8SVIEW_LDAP_ENABLED") == "true"
	return auth.LDAPConfig{
		Enabled:         enabled,
		URL:             os.Getenv("K8SVIEW_LDAP_URL"),
		BindDN:          os.Getenv("K8SVIEW_LDAP_BIND_DN"),
		BindPassword:    os.Getenv("K8SVIEW_LDAP_BIND_PASS"),
		UserSearchBase:  os.Getenv("K8SVIEW_LDAP_USER_SEARCH_BASE"),
		UserFilter:      os.Getenv("K8SVIEW_LDAP_USER_FILTER"),
		GroupSearchBase: os.Getenv("K8SVIEW_LDAP_GROUP_SEARCH_BASE"),
		GroupFilter:     os.Getenv("K8SVIEW_LDAP_GROUP_FILTER"),
		AdminGroupDN:    os.Getenv("K8SVIEW_LDAP_ADMIN_GROUP_DN"),
		StartTLS:        os.Getenv("K8SVIEW_LDAP_STARTTLS") == "true",
	}
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := []string{}
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}
