package clusters

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
	apiversion "k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// Cluster is the per-context state. It owns the typed and dynamic clients,
// a discovery cache, the dynamic informer factory, and the registry of
// active per-GVR informers.
type Cluster struct {
	name    string
	logger  *zap.Logger
	restCfg *rest.Config

	clientset     *kubernetes.Clientset
	dynamic       dynamic.Interface
	metrics       metricsclient.Interface
	disco         discovery.CachedDiscoveryInterface
	mapper        meta.RESTMapper
	informerStore *informerStore

	connected atomic.Bool
	version   atomic.Value // string

	rootCtx context.Context
	cancel  context.CancelFunc
	stopped atomic.Bool

	mu sync.Mutex
}

func newCluster(parent context.Context, name string, rc *rest.Config, logger *zap.Logger) (*Cluster, error) {
	ctx, cancel := context.WithCancel(parent)

	cs, err := kubernetes.NewForConfig(rc)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("kubernetes clientset: %w", err)
	}
	dy, err := dynamic.NewForConfig(rc)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	mc, err := metricsclient.NewForConfig(rc)
	if err != nil {
		// Metrics is optional — many clusters don't run metrics-server.
		logger.Debug("metrics client unavailable", zap.Error(err))
	}

	disco := memory.NewMemCacheClient(cs.Discovery())
	mapper := restmapper.NewDeferredDiscoveryRESTMapper(disco)

	c := &Cluster{
		name:      name,
		logger:    logger,
		restCfg:   rc,
		clientset: cs,
		dynamic:   dy,
		metrics:   mc,
		disco:     disco,
		mapper:    mapper,
		rootCtx:   ctx,
		cancel:    cancel,
	}
	c.informerStore = newInformerStore(c, logger)

	// Probe connectivity in the background. The UI uses Connected() for the
	// status dot in the cluster picker.
	go c.probe()
	logger.Info("cluster configured", zap.String("server", rc.Host))

	return c, nil
}

func (c *Cluster) probe() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	checked := false
	lastErr := ""
	check := func() {
		ctx, cancel := context.WithTimeout(c.rootCtx, 5*time.Second)
		defer cancel()
		v := &apiversion.Info{}
		data, err := c.clientset.Discovery().RESTClient().Get().AbsPath("/version").DoRaw(ctx)
		if err == nil {
			err = json.Unmarshal(data, v)
		}
		if err != nil {
			errText := err.Error()
			if !checked || c.connected.Load() || errText != lastErr {
				c.logger.Warn("cluster connectivity check failed",
					zap.String("server", c.restCfg.Host),
					zap.Error(err))
			}
			checked = true
			lastErr = errText
			c.connected.Store(false)
			return
		}
		if !checked || !c.connected.Load() {
			c.logger.Info("cluster connected",
				zap.String("server", c.restCfg.Host),
				zap.String("version", v.GitVersion))
		}
		checked = true
		lastErr = ""
		c.connected.Store(true)
		c.version.Store(v.GitVersion)
	}
	check()
	for {
		select {
		case <-c.rootCtx.Done():
			return
		case <-t.C:
			check()
		}
	}
}

func (c *Cluster) Name() string                                  { return c.name }
func (c *Cluster) Connected() bool                               { return c.connected.Load() }
func (c *Cluster) RestConfig() *rest.Config                      { return c.restCfg }
func (c *Cluster) Clientset() kubernetes.Interface               { return c.clientset }
func (c *Cluster) Dynamic() dynamic.Interface                    { return c.dynamic }
func (c *Cluster) Metrics() metricsclient.Interface              { return c.metrics }
func (c *Cluster) Discovery() discovery.CachedDiscoveryInterface { return c.disco }
func (c *Cluster) Mapper() meta.RESTMapper                       { return c.mapper }
func (c *Cluster) Context() context.Context                      { return c.rootCtx }

func (c *Cluster) Version() string {
	if v, ok := c.version.Load().(string); ok {
		return v
	}
	return ""
}

// ResolveGVR maps "pods" / "deployments.apps" / "v1/Pod" to a GVR.
func (c *Cluster) ResolveGVR(input string) (schema.GroupVersionResource, error) {
	gvr, _, err := c.informerStore.resolve(input)
	return gvr, err
}

// Subscribe returns a Stream that delivers add/update/delete events for the
// given GVR (and namespace, "" means cluster-wide). The returned stream must
// be closed when the consumer goes away.
func (c *Cluster) Subscribe(gvr schema.GroupVersionResource, namespace string) (*Stream, error) {
	return c.informerStore.subscribe(gvr, namespace)
}

// NewDynamicFactory returns a fresh factory. Used internally; most callers
// should use Subscribe.
func (c *Cluster) NewDynamicFactory(namespace string, resync time.Duration) dynamicinformer.DynamicSharedInformerFactory {
	if namespace == "" {
		return dynamicinformer.NewDynamicSharedInformerFactory(c.dynamic, resync)
	}
	return dynamicinformer.NewFilteredDynamicSharedInformerFactory(
		c.dynamic, resync, namespace, nil)
}

// Stop cancels every informer in this cluster.
func (c *Cluster) Stop() {
	if c.stopped.Swap(true) {
		return
	}
	c.cancel()
	c.informerStore.stopAll()
}
