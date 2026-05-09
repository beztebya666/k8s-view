package clusters

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/cache"
)

// EventKind tells subscribers what kind of delta they just received.
type EventKind string

const (
	EventSnapshot EventKind = "snapshot" // initial full list when subscribing
	EventAdd      EventKind = "add"
	EventUpdate   EventKind = "update"
	EventDelete   EventKind = "delete"
)

// Event is a single delta on the stream.
type Event struct {
	Kind EventKind                    `msgpack:"k" json:"kind"`
	GVR  string                       `msgpack:"g" json:"gvr"`
	UID  string                       `msgpack:"u" json:"uid"`
	Item *unstructured.Unstructured   `msgpack:"i,omitempty" json:"item,omitempty"`
	List []*unstructured.Unstructured `msgpack:"l,omitempty" json:"list,omitempty"`
}

// Stream is a subscription to events from one informer.
type Stream struct {
	ID      uint64
	GVR     schema.GroupVersionResource
	NS      string
	C       chan Event
	closeFn func()
	closed  bool
	mu      sync.Mutex
}

func (s *Stream) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.closeFn != nil {
		s.closeFn()
	}
	// Channel is closed by the informer subscription goroutine.
}

// informerEntry is a single shared informer plus its subscriber list.
type informerEntry struct {
	gvr      schema.GroupVersionResource
	ns       string
	informer cache.SharedIndexInformer
	stopCh   chan struct{}
	cancel   context.CancelFunc

	mu          sync.Mutex
	subs        map[uint64]chan Event
	nextSubID   uint64
	registered  cache.ResourceEventHandlerRegistration
	hasSynced   bool
	resourceVer string
}

// informerStore manages informers per (GVR, namespace).
type informerStore struct {
	c      *Cluster
	logger *zap.Logger

	mu      sync.Mutex
	entries map[string]*informerEntry
}

func newInformerStore(c *Cluster, logger *zap.Logger) *informerStore {
	return &informerStore{
		c:       c,
		logger:  logger,
		entries: map[string]*informerEntry{},
	}
}

func (s *informerStore) key(gvr schema.GroupVersionResource, ns string) string {
	return fmt.Sprintf("%s|%s|%s|%s", gvr.Group, gvr.Version, gvr.Resource, ns)
}

// resolve turns a free-form resource string into a (GVR, namespaced?) tuple.
// Accepts:
//   - "pods"
//   - "deployments.apps"
//   - "v1/Pod"
//   - "apps/v1/Deployment"
//   - "argoproj.io/v1alpha1/Application"
func (s *informerStore) resolve(input string) (schema.GroupVersionResource, bool, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return schema.GroupVersionResource{}, false, fmt.Errorf("empty resource")
	}

	// Slash-separated form: maybe Group/Version/Kind, maybe Version/Kind.
	if strings.Contains(input, "/") && !looksLikeGVR(input) {
		parts := strings.Split(input, "/")
		var gvk schema.GroupVersionKind
		switch len(parts) {
		case 2: // "v1/Pod"
			gvk = schema.GroupVersionKind{Version: parts[0], Kind: parts[1]}
		case 3: // "apps/v1/Deployment"
			gvk = schema.GroupVersionKind{Group: parts[0], Version: parts[1], Kind: parts[2]}
		default:
			return schema.GroupVersionResource{}, false, fmt.Errorf("bad resource %q", input)
		}
		mapping, err := s.c.Mapper().RESTMapping(gvk.GroupKind(), gvk.Version)
		if err != nil {
			return schema.GroupVersionResource{}, false, err
		}
		return mapping.Resource, mapping.Scope.Name() == "namespace", nil
	}

	// Dot form: "deployments.apps", or plain "pods"
	gr := schema.ParseGroupResource(input)
	mapping, err := s.c.Mapper().RESTMapping(schema.GroupKind{Group: gr.Group, Kind: ""},
		"")
	if err == nil {
		return mapping.Resource, mapping.Scope.Name() == "namespace", nil
	}
	// Fall back to discovery: walk preferred resources for the first match.
	preferred, derr := s.c.Discovery().ServerPreferredResources()
	if derr != nil && len(preferred) == 0 {
		return schema.GroupVersionResource{}, false, fmt.Errorf("resolve %q: %w", input, derr)
	}
	for _, list := range preferred {
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range list.APIResources {
			if r.Name == gr.Resource && (gr.Group == "" || gr.Group == gv.Group) {
				return schema.GroupVersionResource{
					Group: gv.Group, Version: gv.Version, Resource: r.Name,
				}, r.Namespaced, nil
			}
		}
	}
	return schema.GroupVersionResource{}, false, fmt.Errorf("resource %q not found", input)
}

func looksLikeGVR(s string) bool {
	// "deployments.apps" contains a dot but no slash.
	return false
}

func (s *informerStore) subscribe(gvr schema.GroupVersionResource, ns string) (*Stream, error) {
	s.mu.Lock()
	key := s.key(gvr, ns)
	entry, ok := s.entries[key]
	created := false
	if !ok {
		factory := s.c.NewDynamicFactory(ns, 0)
		inf := factory.ForResource(gvr).Informer()

		ctx, cancel := context.WithCancel(s.c.Context())
		entry = &informerEntry{
			gvr:      gvr,
			ns:       ns,
			informer: inf,
			stopCh:   make(chan struct{}),
			cancel:   cancel,
			subs:     map[uint64]chan Event{},
		}
		created = true
		s.logger.Info("informer starting",
			zap.String("gvr", gvr.String()),
			zap.String("ns", ns))
		// Wire the event handler before starting the informer so we don't
		// miss the initial deltas.
		reg, err := inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc: func(obj interface{}) {
				entry.broadcast(EventAdd, gvr, obj)
			},
			UpdateFunc: func(_ interface{}, obj interface{}) {
				entry.broadcast(EventUpdate, gvr, obj)
			},
			DeleteFunc: func(obj interface{}) {
				if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
					obj = d.Obj
				}
				entry.broadcast(EventDelete, gvr, obj)
			},
		})
		if err != nil {
			s.mu.Unlock()
			cancel()
			return nil, fmt.Errorf("add handler: %w", err)
		}
		entry.registered = reg

		s.entries[key] = entry
		s.mu.Unlock()

		go func() {
			factory.Start(ctx.Done())
			synced := cache.WaitForCacheSync(ctx.Done(), inf.HasSynced)
			entry.mu.Lock()
			entry.hasSynced = synced
			entry.mu.Unlock()
			if synced {
				s.logger.Info("informer cache synced",
					zap.String("gvr", gvr.String()),
					zap.String("ns", ns))
			} else {
				s.logger.Debug("informer cache sync stopped",
					zap.String("gvr", gvr.String()),
					zap.String("ns", ns))
			}
			<-ctx.Done()
		}()
	} else {
		s.mu.Unlock()
	}

	snap, err := s.initialSnapshot(entry, gvr, ns)
	if err != nil {
		if created {
			s.removeEntry(key, entry)
		}
		return nil, err
	}

	entry.mu.Lock()
	entry.nextSubID++
	id := entry.nextSubID
	ch := make(chan Event, 256)
	entry.subs[id] = ch
	entry.mu.Unlock()

	ch <- Event{Kind: EventSnapshot, GVR: gvr.String(), List: snap}

	stream := &Stream{
		ID:  id,
		GVR: gvr,
		NS:  ns,
		C:   ch,
	}
	stream.closeFn = func() {
		entry.mu.Lock()
		delete(entry.subs, id)
		empty := len(entry.subs) == 0
		entry.mu.Unlock()
		close(ch)
		if empty {
			s.maybeStop(key, entry)
		}
	}
	return stream, nil
}

func (s *informerStore) initialSnapshot(
	entry *informerEntry,
	gvr schema.GroupVersionResource,
	ns string,
) ([]*unstructured.Unstructured, error) {
	if entry.informer.HasSynced() {
		items := entry.informer.GetStore().List()
		snap := make([]*unstructured.Unstructured, 0, len(items))
		for _, it := range items {
			if u, ok := it.(*unstructured.Unstructured); ok {
				snap = append(snap, u)
			}
		}
		s.logger.Debug("snapshot loaded from informer cache",
			zap.String("gvr", gvr.String()),
			zap.String("ns", ns),
			zap.Int("items", len(snap)))
		return snap, nil
	}

	start := time.Now()
	ctx, cancel := context.WithTimeout(s.c.Context(), 30*time.Second)
	defer cancel()

	ri := s.c.Dynamic().Resource(gvr)
	var (
		list *unstructured.UnstructuredList
		err  error
	)
	if ns != "" {
		list, err = ri.Namespace(ns).List(ctx, metav1.ListOptions{})
	} else {
		list, err = ri.List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		s.logger.Warn("initial resource list failed",
			zap.String("gvr", gvr.String()),
			zap.String("ns", ns),
			zap.Duration("duration", time.Since(start)),
			zap.Error(err))
		return nil, fmt.Errorf("initial list for %s namespace %q: %w", gvr.String(), ns, err)
	}

	snap := make([]*unstructured.Unstructured, 0, len(list.Items))
	for i := range list.Items {
		snap = append(snap, &list.Items[i])
	}
	s.logger.Info("snapshot loaded from api server",
		zap.String("gvr", gvr.String()),
		zap.String("ns", ns),
		zap.Int("items", len(snap)),
		zap.Duration("duration", time.Since(start)))
	return snap, nil
}

func (s *informerStore) removeEntry(key string, e *informerEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.entries[key]; ok && cur == e {
		delete(s.entries, key)
		e.cancel()
	}
}

func (e *informerEntry) broadcast(kind EventKind, gvr schema.GroupVersionResource, obj interface{}) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return
	}
	uid := string(u.GetUID())
	e.mu.Lock()
	subs := make([]chan Event, 0, len(e.subs))
	for _, c := range e.subs {
		subs = append(subs, c)
	}
	e.mu.Unlock()
	ev := Event{Kind: kind, GVR: gvr.String(), UID: uid, Item: u}
	for _, c := range subs {
		select {
		case c <- ev:
		default:
			// Slow consumer — drop. The UI re-syncs on reconnect.
		}
	}
}

func (s *informerStore) maybeStop(key string, e *informerEntry) {
	// Keep informers warm for a short while in case the user just
	// navigated away and is about to come back.
	go func() {
		time.Sleep(60 * time.Second)
		e.mu.Lock()
		stillEmpty := len(e.subs) == 0
		e.mu.Unlock()
		if !stillEmpty {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if cur, ok := s.entries[key]; ok && cur == e {
			delete(s.entries, key)
			e.cancel()
			s.logger.Debug("informer stopped",
				zap.String("gvr", e.gvr.String()),
				zap.String("ns", e.ns))
		}
	}()
}

func (s *informerStore) stopAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.entries {
		e.cancel()
	}
	s.entries = map[string]*informerEntry{}
}

// ListAPIResources returns every API resource the cluster advertises.
type APIResource struct {
	Group        string   `json:"group"`
	Version      string   `json:"version"`
	Kind         string   `json:"kind"`
	Name         string   `json:"name"`
	SingularName string   `json:"singularName"`
	Namespaced   bool     `json:"namespaced"`
	Verbs        []string `json:"verbs"`
	ShortNames   []string `json:"shortNames,omitempty"`
	Categories   []string `json:"categories,omitempty"`
}

func (c *Cluster) ListAPIResources() ([]APIResource, error) {
	c.disco.Invalidate()
	preferred, err := c.disco.ServerPreferredResources()
	if err != nil && len(preferred) == 0 {
		return nil, err
	}
	var out []APIResource
	for _, list := range preferred {
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range list.APIResources {
			if strings.Contains(r.Name, "/") {
				continue // sub-resources like pods/log
			}
			out = append(out, APIResource{
				Group:        gv.Group,
				Version:      gv.Version,
				Kind:         r.Kind,
				Name:         r.Name,
				SingularName: r.SingularName,
				Namespaced:   r.Namespaced,
				Verbs:        r.Verbs,
				ShortNames:   r.ShortNames,
				Categories:   r.Categories,
			})
		}
	}
	return out, nil
}

// ListNamespaces is a convenience for the namespace selector.
func (c *Cluster) ListNamespaces(ctx context.Context) ([]string, error) {
	nss, err := c.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(nss.Items))
	for _, n := range nss.Items {
		out = append(out, n.Name)
	}
	return out, nil
}
