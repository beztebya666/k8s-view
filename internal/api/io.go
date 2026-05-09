package api

import (
	"io"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/tools/remotecommand"
)

// pipe is a tiny in-memory io.Reader/io.WriteCloser pair so we can hand the
// remotecommand executor an io.Reader for stdin while still writing into it
// from a goroutine handling the websocket.
type pipe struct {
	mu    sync.Mutex
	cond  *sync.Cond
	buf   []byte
	closed bool
}

func newPipe() (io.Reader, io.WriteCloser) {
	p := &pipe{}
	p.cond = sync.NewCond(&p.mu)
	return p, p
}

func (p *pipe) Read(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for len(p.buf) == 0 && !p.closed {
		p.cond.Wait()
	}
	if len(p.buf) == 0 && p.closed {
		return 0, io.EOF
	}
	n := copy(b, p.buf)
	p.buf = p.buf[n:]
	return n, nil
}

func (p *pipe) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, io.ErrClosedPipe
	}
	p.buf = append(p.buf, b...)
	p.cond.Signal()
	return len(b), nil
}

func (p *pipe) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.cond.Broadcast()
	return nil
}

// wsWriter writes blobs to a WebSocket as discrete frames. We need this so
// stdout from exec is written as a binary frame the browser can render byte
// for byte (xterm.js).
type wsWriter struct {
	conn *websocket.Conn
	mt   int
	mu   sync.Mutex
}

func newWSWriter(conn *websocket.Conn, mt int) *wsWriter {
	return &wsWriter{conn: conn, mt: mt}
}

func (w *wsWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := w.conn.WriteMessage(w.mt, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

// resizeQueue implements remotecommand.TerminalSizeQueue.
type resizeQueue struct {
	mu sync.Mutex
	c  chan remotecommand.TerminalSize
}

func newResizeQueue() *resizeQueue {
	return &resizeQueue{c: make(chan remotecommand.TerminalSize, 8)}
}

func (q *resizeQueue) push(s remotecommand.TerminalSize) {
	select {
	case q.c <- s:
	default:
	}
}

func (q *resizeQueue) Next() *remotecommand.TerminalSize {
	s, ok := <-q.c
	if !ok {
		return nil
	}
	return &s
}
