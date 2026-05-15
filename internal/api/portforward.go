package api

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

var pfUpgrader = websocket.Upgrader{
	ReadBufferSize:  1 << 14,
	WriteBufferSize: 1 << 16,
	CheckOrigin:     func(_ *http.Request) bool { return true },
}

// podPortForward sets up a port-forward and proxies a single TCP-like stream
// over the WebSocket. The browser opens a websocket per "session" — one per
// (pod, port) — and reads/writes raw bytes as binary frames.
//
// This is the building block for the in-browser "open in new tab" feature
// the UI exposes for HTTP services.
func (h *handlers) podPortForward(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := urlParam(r, "namespace")
	pod := urlParam(r, "name")

	target, err := strconv.Atoi(r.URL.Query().Get("port"))
	if err != nil || target <= 0 {
		h.writeError(w, r, http.StatusBadRequest, errParse("port"))
		return
	}
	local, _ := strconv.Atoi(r.URL.Query().Get("local")) // 0 → ephemeral

	conn, err := pfUpgrader.Upgrade(w, r, nil)
	if err != nil {
		h.deps.Logger.Warn("portforward upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	roundTripper, upgrader, err := spdy.RoundTripperFor(c.RestConfig())
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}
	path := strings.Join([]string{
		"/api/v1/namespaces", ns, "pods", pod, "portforward",
	}, "/")
	host := strings.TrimRight(c.RestConfig().Host, "/")
	u, err := url.Parse(host + path)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}

	dialer := spdy.NewDialer(upgrader,
		&http.Client{Transport: roundTripper, Timeout: 30 * time.Second}, "POST", u)

	stopCh := make(chan struct{}, 1)
	readyCh := make(chan struct{})
	ports := []string{strconv.Itoa(local) + ":" + strconv.Itoa(target)}

	pf, err := portforward.New(dialer, ports, stopCh, readyCh, &wsForwardSink{conn: conn}, &wsForwardSink{conn: conn})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}

	once := sync.Once{}
	closeAll := func() { once.Do(func() { close(stopCh) }) }
	defer closeAll()

	go func() {
		// If the browser disconnects, kill the port-forward.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				closeAll()
				return
			}
		}
	}()

	go func() {
		<-readyCh
		ports, err := pf.GetPorts()
		if err != nil {
			return
		}
		// Tell the browser which local port we got.
		for _, p := range ports {
			_ = conn.WriteMessage(websocket.TextMessage,
				[]byte("ready "+strconv.Itoa(int(p.Local))+":"+strconv.Itoa(int(p.Remote))))
		}
	}()

	if err := pf.ForwardPorts(); err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("port-forward ended: "+err.Error()))
	}
}

type wsForwardSink struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (s *wsForwardSink) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := s.conn.WriteMessage(websocket.TextMessage, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

type errParse string

func (e errParse) Error() string { return "invalid value for " + string(e) }
