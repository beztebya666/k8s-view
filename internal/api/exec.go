package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

var execUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 1 << 15,
	CheckOrigin:     func(_ *http.Request) bool { return true },
}

// podExec proxies an interactive shell into a container over a WebSocket.
//
// Frames from client → server:
//   - Binary frame: stdin bytes (raw).
//   - Text frame "{\"resize\":{\"cols\":N,\"rows\":N}}": resize the PTY.
//
// Frames from server → client:
//   - Binary frame: stdout bytes.
//
// Query params:
//
//	container=<name>
//	command=/bin/sh   (repeatable; defaults to ["/bin/sh"])
func (h *handlers) podExec(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}

	ns := chi.URLParam(r, "namespace")
	pod := chi.URLParam(r, "name")
	q := r.URL.Query()
	container := q.Get("container")
	cmd := q["command"]
	if len(cmd) == 0 {
		// Lens-style default: clear + try bash → ash → sh in turn so the
		// session lands on the best available shell without the caller having
		// to know what's installed.
		cmd = []string{"sh", "-c", "clear; (bash || ash || sh)"}
	}

	conn, err := execUpgrader.Upgrade(w, r, nil)
	if err != nil {
		h.deps.Logger.Warn("exec upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	req := c.Clientset().CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(ns).
		SubResource("exec")
	req.VersionedParams(&corev1.PodExecOptions{
		Container: container,
		Command:   cmd,
		Stdin:     true,
		Stdout:    true,
		Stderr:    true,
		TTY:       true,
	}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(c.RestConfig(), "POST", req.URL())
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("exec init: "+err.Error()))
		return
	}

	stdin, stdinW := newPipe()
	queue := newResizeQueue()

	go func() {
		defer stdinW.Close()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mt == websocket.TextMessage && len(data) > 0 && data[0] == '{' {
				var ctrl struct {
					Resize *struct {
						Cols uint16 `json:"cols"`
						Rows uint16 `json:"rows"`
					} `json:"resize,omitempty"`
				}
				if err := json.Unmarshal(data, &ctrl); err == nil && ctrl.Resize != nil {
					queue.push(remotecommand.TerminalSize{
						Width: ctrl.Resize.Cols, Height: ctrl.Resize.Rows,
					})
					continue
				}
			}
			_, _ = stdinW.Write(data)
		}
	}()

	out := newWSWriter(conn, websocket.BinaryMessage)
	err = executor.StreamWithContext(r.Context(), remotecommand.StreamOptions{
		Stdin:             stdin,
		Stdout:            out,
		Stderr:            out,
		Tty:               true,
		TerminalSizeQueue: queue,
	})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\n[exec ended: "+err.Error()+"]\r\n"))
		return
	}
}

// podAttach proxies the Kubernetes attach subresource over the same terminal
// WebSocket protocol as exec. Attach connects to the selected container's main
// process instead of starting a new command.
func (h *handlers) podAttach(w http.ResponseWriter, r *http.Request) {
	c, err := h.cluster(r)
	if err != nil {
		h.writeError(w, r, http.StatusNotFound, err)
		return
	}

	ns := chi.URLParam(r, "namespace")
	pod := chi.URLParam(r, "name")
	container := r.URL.Query().Get("container")

	conn, err := execUpgrader.Upgrade(w, r, nil)
	if err != nil {
		h.deps.Logger.Warn("attach upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	req := c.Clientset().CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(ns).
		SubResource("attach")
	req.VersionedParams(&corev1.PodAttachOptions{
		Container: container,
		Stdin:     true,
		Stdout:    true,
		Stderr:    true,
		TTY:       true,
	}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(c.RestConfig(), "POST", req.URL())
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("attach init: "+err.Error()))
		return
	}

	stdin, stdinW := newPipe()
	queue := newResizeQueue()

	go func() {
		defer stdinW.Close()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mt == websocket.TextMessage && len(data) > 0 && data[0] == '{' {
				var ctrl struct {
					Resize *struct {
						Cols uint16 `json:"cols"`
						Rows uint16 `json:"rows"`
					} `json:"resize,omitempty"`
				}
				if err := json.Unmarshal(data, &ctrl); err == nil && ctrl.Resize != nil {
					queue.push(remotecommand.TerminalSize{
						Width: ctrl.Resize.Cols, Height: ctrl.Resize.Rows,
					})
					continue
				}
			}
			_, _ = stdinW.Write(data)
		}
	}()

	out := newWSWriter(conn, websocket.BinaryMessage)
	err = executor.StreamWithContext(r.Context(), remotecommand.StreamOptions{
		Stdin:             stdin,
		Stdout:            out,
		Stderr:            out,
		Tty:               true,
		TerminalSizeQueue: queue,
	})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\n[attach ended: "+err.Error()+"]\r\n"))
		return
	}
}
