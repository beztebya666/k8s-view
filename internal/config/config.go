// Package config holds the runtime configuration of the k8s-view server.
//
// Values are populated from CLI flags first, then environment variables, then
// sensible defaults. We keep the surface area intentionally small — anything
// the user might tweak in production should appear here exactly once.
package config

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
)

// Config is the resolved runtime configuration.
type Config struct {
	ListenAddr         string
	Kubeconfig         string
	InCluster          bool
	LogLevel           string
	AllowOrigins       []string
	ResyncSeconds      int
	DefaultClusterName string

	// Open the dashboard in the default browser on startup. Defaults to on
	// for local runs and off in-cluster (a pod has no browser).
	Open bool

	// Distributed mode (optional)
	Mode      string // "all-in-one" | "api" | "worker"
	RedisAddr string

	// Auth
	BasicAuthUser string
	BasicAuthPass string
}

// FromFlags wires config values to the standard flag set. Call flag.Parse()
// after this returns.
func FromFlags() *Config {
	c := &Config{}

	flag.StringVar(&c.ListenAddr, "listen", envOr("K8SVIEW_LISTEN", ":8080"),
		"address the HTTP server binds to")
	flag.StringVar(&c.Kubeconfig, "kubeconfig", envOr("KUBECONFIG", defaultKubeconfig()),
		"path to a kubeconfig file (ignored when --in-cluster is set)")
	flag.BoolVar(&c.InCluster, "in-cluster", envBool("K8SVIEW_IN_CLUSTER", inClusterDetect()),
		"use the pod's service-account credentials instead of a kubeconfig")
	flag.StringVar(&c.LogLevel, "log-level", envOr("K8SVIEW_LOG_LEVEL", "info"),
		"log verbosity: debug | info | warn | error")
	flag.IntVar(&c.ResyncSeconds, "resync-seconds", envInt("K8SVIEW_RESYNC_SECONDS", 0),
		"informer resync period in seconds (0 disables periodic resync — only deltas are sent)")
	flag.StringVar(&c.DefaultClusterName, "default-cluster", envOr("K8SVIEW_DEFAULT_CLUSTER", ""),
		"name of the cluster to select on first load (default: current-context)")
	flag.BoolVar(&c.Open, "open", envBool("K8SVIEW_OPEN", !inClusterDetect()),
		"open the dashboard in the default browser on startup (on for local runs, off in-cluster)")
	flag.StringVar(&c.Mode, "mode", envOr("K8SVIEW_MODE", "all-in-one"),
		"deployment mode: all-in-one | api | worker")
	flag.StringVar(&c.RedisAddr, "redis", envOr("K8SVIEW_REDIS", ""),
		"redis address for distributed cache (only when mode != all-in-one)")
	flag.StringVar(&c.BasicAuthUser, "basic-auth-user", envOr("K8SVIEW_BASIC_AUTH_USER", ""),
		"if set, require HTTP basic-auth with this user name")
	flag.StringVar(&c.BasicAuthPass, "basic-auth-pass", envOr("K8SVIEW_BASIC_AUTH_PASS", ""),
		"basic-auth password (paired with --basic-auth-user)")
	origins := flag.String("allow-origins", envOr("K8SVIEW_ALLOW_ORIGINS", "*"),
		"comma-separated list of CORS allowed origins")
	flag.Parse()

	for _, o := range strings.Split(*origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowOrigins = append(c.AllowOrigins, o)
		}
	}
	if len(c.AllowOrigins) == 0 {
		c.AllowOrigins = []string{"*"}
	}
	return c
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func defaultKubeconfig() string {
	if v := os.Getenv("KUBECONFIG"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".kube", "config")
}

func inClusterDetect() bool {
	_, err := os.Stat("/var/run/secrets/kubernetes.io/serviceaccount/token")
	return err == nil
}
