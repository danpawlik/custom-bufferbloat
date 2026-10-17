package handlers

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/openwrt-builder/custom-bufferbloat/internal/lock"
)

const (
	defaultDownloadSize = 8 << 20 // 8 MiB
	maxDownloadSize     = 64 << 20
	maxUploadBytes      = 64 << 20
	downloadTimeout     = 30 * time.Second
	chunkSize           = 64 << 10
	maxSessionJSON      = 4096
)

// Server holds shared dependencies for HTTP handlers.
type Server struct {
	Lock            *lock.TestLock
	DownloadStreams int
	MaxConcurrent   int
}

func New(l *lock.TestLock, downloadStreams, maxConcurrent int) *Server {
	if downloadStreams < 1 {
		downloadStreams = 4
	}
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	return &Server{
		Lock:            l,
		DownloadStreams: downloadStreams,
		MaxConcurrent:   maxConcurrent,
	}
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health", s.Health)
	mux.HandleFunc("GET /ping", s.Ping)
	mux.HandleFunc("GET /download", s.Download)
	mux.HandleFunc("POST /upload", s.Upload)
	mux.HandleFunc("POST /test/begin", s.Begin)
	mux.HandleFunc("POST /test/end", s.End)
	mux.HandleFunc("GET /api/config", s.Config)
}

func (s *Server) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) Config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"downloadStreams": s.DownloadStreams,
		"maxConcurrent":   s.MaxConcurrent,
	})
}

func (s *Server) Ping(w http.ResponseWriter, r *http.Request) {
	// Optional session refreshes TTL during an active test.
	if id := sessionFrom(r); id != "" {
		_ = s.Lock.Touch(id)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Server-Time", strconv.FormatInt(time.Now().UnixNano(), 10))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"pong":true}`))
}

func (s *Server) requireSession(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := sessionFrom(r)
	if id == "" || !s.Lock.Touch(id) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": "active test session required (call /test/begin first)",
		})
		return "", false
	}
	return id, true
}

func sessionFrom(r *http.Request) string {
	if id := r.Header.Get("X-Session-Id"); id != "" {
		return id
	}
	return r.URL.Query().Get("sessionId")
}

func (s *Server) Download(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireSession(w, r); !ok {
		return
	}

	size := defaultDownloadSize
	if v := r.URL.Query().Get("size"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			http.Error(w, "invalid size", http.StatusBadRequest)
			return
		}
		if n > maxDownloadSize {
			n = maxDownloadSize
		}
		size = int(n)
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(size))

	ctx := r.Context()
	deadline := time.Now().Add(downloadTimeout)
	buf := make([]byte, chunkSize)
	_, _ = rand.Read(buf)

	remaining := size
	flusher, canFlush := w.(http.Flusher)
	for remaining > 0 {
		if err := ctx.Err(); err != nil {
			return
		}
		if time.Now().After(deadline) {
			return
		}
		n := chunkSize
		if n > remaining {
			n = remaining
		}
		if _, err := w.Write(buf[:n]); err != nil {
			return
		}
		if canFlush {
			flusher.Flush()
		}
		remaining -= n
	}
}

func (s *Server) Upload(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireSession(w, r); !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	n, err := io.Copy(io.Discard, r.Body)
	if err != nil {
		http.Error(w, "upload failed", http.StatusRequestEntityTooLarge)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": n})
}

type sessionBody struct {
	SessionID string `json:"sessionId"`
}

func (s *Server) Begin(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSessionJSON)
	var body sessionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionID == "" {
		http.Error(w, "sessionId required", http.StatusBadRequest)
		return
	}
	if !s.Lock.TryAcquire(body.SessionID) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "test already running",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessionId": body.SessionID})
}

func (s *Server) End(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSessionJSON)
	var body sessionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionID == "" {
		http.Error(w, "sessionId required", http.StatusBadRequest)
		return
	}
	s.Lock.Release(body.SessionID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
