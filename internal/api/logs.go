package api

import (
	"bufio"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var logsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 1 << 16,
	CheckOrigin:     func(_ *http.Request) bool { return true },
}

// podLogs streams a pod's logs over a websocket. Query params:
//
//	container=<name>     specific container (default: first container)
//	tail=<n>             tail lines (default: 200, -1 = all)
//	sinceTime=<RFC3339>  continue after the newest line already held by the UI
//	previous=true        previous instance
//	timestamps=true      include timestamps
//	follow=true          stream new lines as they arrive (default true)
func (h *handlers) podLogs(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}
	ns := urlParam(r, "namespace")
	pod := urlParam(r, "name")
	q := r.URL.Query()

	follow := q.Get("follow") != "false"
	previous := q.Get("previous") == "true"
	timestamps := q.Get("timestamps") == "true"
	sinceRaw := q.Get("sinceTime")
	var sinceTime *metav1.Time
	if sinceRaw != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, sinceRaw); err == nil {
			sinceTime = &metav1.Time{Time: parsed}
		} else {
			h.deps.Logger.Debug("logs sinceTime ignored", zap.String("since_time", sinceRaw), zap.Error(err))
		}
	}
	tail := int64(200)
	if t, err := strconv.ParseInt(q.Get("tail"), 10, 64); err == nil {
		tail = t
	}

	opts := &corev1.PodLogOptions{
		Container:  q.Get("container"),
		Follow:     follow,
		Previous:   previous,
		Timestamps: timestamps,
		SinceTime:  sinceTime,
	}
	if sinceTime == nil && tail >= 0 {
		opts.TailLines = &tail
	}

	conn, err := logsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		h.deps.Logger.Warn("logs upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	req := c.Clientset().CoreV1().Pods(ns).GetLogs(pod, opts)
	stream, err := req.Stream(r.Context())
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage,
			[]byte("error: "+err.Error()))
		return
	}
	defer stream.Close()

	go func() {
		// Drain client→server frames so the connection stays alive and we
		// notice client closure quickly.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				_ = stream.Close()
				return
			}
		}
	}()

	br := bufio.NewReaderSize(stream, 1<<16)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			_ = conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if werr := conn.WriteMessage(websocket.TextMessage, line); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}
