package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"

	"github.com/k8s-view/k8s-view/internal/clusters"
)

// stream upgrades the HTTP connection to a WebSocket and multiplexes one or
// more informer subscriptions over it. The protocol is intentionally tiny:
//
//   client → server   {"op":"subscribe","gvr":"apps/v1/Deployment","ns":"prod","sid":42}
//   client → server   {"op":"unsubscribe","sid":42}
//   client → server   {"op":"ping"}
//
//   server → client (MessagePack, binary frames)
//     { "sid": 42, "kind": "snapshot", "list": [...] }
//     { "sid": 42, "kind": "add",      "item": {...} }
//     { "sid": 42, "kind": "update",   "item": {...} }
//     { "sid": 42, "kind": "delete",   "uid": "..." }
//     { "sid": 0,  "kind": "error",    "msg": "..." }
//
// JSON text frames are also accepted as a fallback (?format=json) so it
// works in `wscat` without an msgpack decoder.

type subscribeMsg struct {
	Op  string `json:"op"`
	SID uint64 `json:"sid"`
	GVR string `json:"gvr"`
	NS  string `json:"ns,omitempty"`
}

type frame struct {
	SID  uint64      `msgpack:"sid"  json:"sid"`
	Kind string      `msgpack:"kind" json:"kind"`
	GVR  string      `msgpack:"gvr,omitempty" json:"gvr,omitempty"`
	UID  string      `msgpack:"uid,omitempty" json:"uid,omitempty"`
	Item interface{} `msgpack:"item,omitempty" json:"item,omitempty"`
	List interface{} `msgpack:"list,omitempty" json:"list,omitempty"`
	Msg  string      `msgpack:"msg,omitempty"  json:"msg,omitempty"`
}

var streamUpgrader = websocket.Upgrader{
	ReadBufferSize:  1 << 14,
	WriteBufferSize: 1 << 16,
	CheckOrigin:     func(_ *http.Request) bool { return true },
	Subprotocols:    []string{"k8s-view.msgpack.v1", "k8s-view.json.v1"},
}

func (h *handlers) stream(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}

	conn, err := streamUpgrader.Upgrade(w, r, nil)
	if err != nil {
		h.deps.Logger.Warn("ws upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	useJSON := r.URL.Query().Get("format") == "json" || conn.Subprotocol() == "k8s-view.json.v1"
	baseLogger := h.deps.Logger
	if baseLogger == nil {
		baseLogger = zap.NewNop()
	}
	logger := baseLogger.With(
		zap.String("cluster", c.Name()),
		zap.String("remote", r.RemoteAddr),
		zap.String("subprotocol", conn.Subprotocol()),
		zap.Bool("json", useJSON),
	)
	start := time.Now()
	logger.Info("websocket connected")
	defer logger.Info("websocket closed", zap.Duration("duration", time.Since(start)))

	mux := newStreamMux(c, conn, useJSON, logger)
	mux.run(r.Context())
}

type streamMux struct {
	c       *clusters.Cluster
	conn    *websocket.Conn
	useJSON bool
	logger  *zap.Logger

	mu   sync.Mutex
	subs map[uint64]*clusters.Stream
	out  chan frame
	stop chan struct{}
	once sync.Once
}

func newStreamMux(c *clusters.Cluster, conn *websocket.Conn, useJSON bool, logger *zap.Logger) *streamMux {
	return &streamMux{
		c:       c,
		conn:    conn,
		useJSON: useJSON,
		logger:  logger,
		subs:    map[uint64]*clusters.Stream{},
		out:     make(chan frame, 1024),
		stop:    make(chan struct{}),
	}
}

func (m *streamMux) run(reqCtx interface{ Done() <-chan struct{} }) {
	go m.writer()
	go func() {
		<-reqCtx.Done()
		m.shutdown()
	}()

	// Reader loop. On any client message we either subscribe a new GVR or
	// drop the websocket on protocol error.
	m.conn.SetReadLimit(1 << 20)
	_ = m.conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	m.conn.SetPongHandler(func(string) error {
		_ = m.conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		return nil
	})

	go m.pinger()

	for {
		_, data, err := m.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				m.logger.Warn("websocket read failed", zap.Error(err))
			} else {
				m.logger.Debug("websocket read stopped", zap.Error(err))
			}
			m.shutdown()
			return
		}
		var msg subscribeMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			m.logger.Warn("websocket received bad json", zap.Error(err))
			m.send(frame{Kind: "error", Msg: "bad json: " + err.Error()})
			continue
		}
		switch strings.ToLower(msg.Op) {
		case "subscribe":
			m.handleSubscribe(msg)
		case "unsubscribe":
			m.handleUnsubscribe(msg.SID)
		case "ping":
			m.send(frame{Kind: "pong", SID: msg.SID})
		default:
			m.send(frame{Kind: "error", SID: msg.SID, Msg: "unknown op " + msg.Op})
		}
	}
}

func (m *streamMux) handleSubscribe(msg subscribeMsg) {
	start := time.Now()
	m.logger.Info("stream subscribe requested",
		zap.Uint64("sid", msg.SID),
		zap.String("requested_gvr", msg.GVR),
		zap.String("ns", msg.NS))
	gvr, err := m.c.ResolveGVR(msg.GVR)
	if err != nil {
		m.logger.Warn("stream subscribe resolve failed",
			zap.Uint64("sid", msg.SID),
			zap.String("requested_gvr", msg.GVR),
			zap.String("ns", msg.NS),
			zap.Error(err))
		m.send(frame{Kind: "error", SID: msg.SID, Msg: err.Error()})
		return
	}
	stream, err := m.c.Subscribe(gvr, msg.NS)
	if err != nil {
		m.logger.Warn("stream subscribe failed",
			zap.Uint64("sid", msg.SID),
			zap.String("requested_gvr", msg.GVR),
			zap.String("resolved_gvr", gvr.String()),
			zap.String("ns", msg.NS),
			zap.Duration("duration", time.Since(start)),
			zap.Error(err))
		m.send(frame{Kind: "error", SID: msg.SID, Msg: err.Error()})
		return
	}
	m.mu.Lock()
	if existing, ok := m.subs[msg.SID]; ok {
		existing.Close()
	}
	m.subs[msg.SID] = stream
	m.mu.Unlock()

	m.logger.Info("stream subscribed",
		zap.Uint64("sid", msg.SID),
		zap.String("requested_gvr", msg.GVR),
		zap.String("resolved_gvr", gvr.String()),
		zap.String("ns", msg.NS),
		zap.Duration("duration", time.Since(start)))
	go m.pumpStream(msg.SID, stream)
}

func (m *streamMux) handleUnsubscribe(sid uint64) {
	m.mu.Lock()
	s, ok := m.subs[sid]
	delete(m.subs, sid)
	m.mu.Unlock()
	if ok {
		s.Close()
		m.logger.Debug("stream unsubscribed", zap.Uint64("sid", sid))
	}
}

func (m *streamMux) pumpStream(sid uint64, s *clusters.Stream) {
	for ev := range s.C {
		f := frame{SID: sid, Kind: string(ev.Kind), GVR: ev.GVR, UID: ev.UID}
		if ev.Item != nil {
			f.Item = ev.Item.Object
		}
		if ev.List != nil {
			arr := make([]interface{}, len(ev.List))
			for i, u := range ev.List {
				arr[i] = u.Object
			}
			f.List = arr
			m.logger.Info("stream snapshot queued",
				zap.Uint64("sid", sid),
				zap.String("gvr", ev.GVR),
				zap.String("ns", s.NS),
				zap.Int("items", len(arr)))
		}
		select {
		case m.out <- f:
		case <-m.stop:
			return
		}
	}
}

func (m *streamMux) writer() {
	for {
		select {
		case f := <-m.out:
			var (
				data []byte
				typ  int
				err  error
			)
			if m.useJSON {
				data, err = json.Marshal(f)
				typ = websocket.TextMessage
			} else {
				data, err = msgpack.Marshal(f)
				typ = websocket.BinaryMessage
			}
			if err != nil {
				m.logger.Warn("stream frame encode failed",
					zap.Uint64("sid", f.SID),
					zap.String("kind", f.Kind),
					zap.String("gvr", f.GVR),
					zap.Error(err))
				continue
			}
			_ = m.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if err := m.conn.WriteMessage(typ, data); err != nil {
				m.logger.Warn("websocket write failed", zap.Error(err))
				m.shutdown()
				return
			}
			if f.Kind == string(clusters.EventSnapshot) {
				m.logger.Info("stream snapshot written",
					zap.Uint64("sid", f.SID),
					zap.String("gvr", f.GVR),
					zap.Int("bytes", len(data)),
					zap.Bool("json", m.useJSON))
			}
		case <-m.stop:
			return
		}
	}
}

func (m *streamMux) pinger() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
			_ = m.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if err := m.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				m.logger.Warn("websocket ping failed", zap.Error(err))
				m.shutdown()
				return
			}
		}
	}
}

func (m *streamMux) send(f frame) {
	select {
	case m.out <- f:
	case <-time.After(5 * time.Second):
	}
}

func (m *streamMux) shutdown() {
	m.once.Do(func() {
		close(m.stop)
		m.mu.Lock()
		for _, s := range m.subs {
			s.Close()
		}
		m.subs = nil
		m.mu.Unlock()
		_ = m.conn.Close()
	})
}
