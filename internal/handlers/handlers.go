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
	chunkSize           = 256 << 10
	maxSessionJSON      = 4096
)

// Server holds shared dependencies for HTTP handlers.
type Server struct {
	Lock            *lock.TestLock
	DownloadStreams int
	UploadStreams   int
	MaxConcurrent   int
	downloadBuffer  []byte
}

func New(l *lock.TestLock, downloadStreams, uploadStreams, maxConcurrent int) *Server {
	if downloadStreams < 1 {
		downloadStreams = 4
	}
	if uploadStreams < 1 {
		// Upload is client-CPU heavy; default lower than download.
		uploadStreams = 2
	}
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	// Reuse an immutable payload across requests to avoid allocation and random generation under load.
	buf := make([]byte, chunkSize)
	if _, err := rand.Read(buf); err != nil {
		panic("generate download payload: " + err.Error())
	}
	return &Server{
		Lock:            l,
		downloadBuffer:  buf,
		DownloadStreams: downloadStreams,
		UploadStreams:   uploadStreams,
		MaxConcurrent:   maxConcurrent,
	}
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health", s.Health)
	mux.HandleFunc("GET /ping", s.Ping)
	mux.HandleFunc("GET /download", s.Download)
	mux.HandleFunc("POST /upload", s.Upload)
	mux.HandleFunc("GET /test/stats", s.Stats)
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
		"uploadStreams":   s.UploadStreams,
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

	remaining := size
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
		if _, err := w.Write(s.downloadBuffer[:n]); err != nil {
			return
		}
		remaining -= n
	}
}

func uploadPhase(r *http.Request) (int, bool) {
	switch r.URL.Query().Get("phase") {
	case "", "upload":
		return 0, true
	case "bidir":
		return 1, true
	default:
		return 0, false
	}
}

func (s *Server) Stats(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	phase, ok := uploadPhase(r)
	if !ok {
		http.Error(w, "invalid phase", http.StatusBadRequest)
		return
	}
	stats, ok := s.Lock.UploadStats(id, phase)
	if !ok {
		http.Error(w, "session expired", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, stats)
}

type uploadCounter struct {
	lock  *lock.TestLock
	id    string
	phase int
}

func (c uploadCounter) Write(p []byte) (int, error) {
	if !c.lock.Upload(c.id, c.phase, int64(len(p)), 0) {
		return 0, io.ErrClosedPipe
	}
	return len(p), nil
}

func (s *Server) Upload(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	phase, ok := uploadPhase(r)
	if !ok {
		http.Error(w, "invalid phase", http.StatusBadRequest)
		return
	}
	if !s.Lock.Upload(id, phase, 0, 1) {
		http.Error(w, "session expired", http.StatusForbidden)
		return
	}
	defer s.Lock.Upload(id, phase, 0, -1)
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	n, err := io.Copy(uploadCounter{s.Lock, id, phase}, r.Body)
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
