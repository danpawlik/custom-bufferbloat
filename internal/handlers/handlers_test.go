package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openwrt-builder/custom-bufferbloat/internal/lock"
)

func testServer() *Server {
	return New(lock.New(1, time.Minute), 4, 2, 1)
}

func beginSession(t *testing.T, s *Server, id string) {
	t.Helper()
	rr := httptest.NewRecorder()
	b, _ := json.Marshal(map[string]string{"sessionId": id})
	req := httptest.NewRequest(http.MethodPost, "/test/begin", bytes.NewReader(b))
	s.Begin(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("begin status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestHealth(t *testing.T) {
	s := testServer()
	rr := httptest.NewRecorder()
	s.Health(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"ok":true`) {
		t.Fatalf("body=%s", rr.Body.String())
	}
}

func TestPing(t *testing.T) {
	s := testServer()
	rr := httptest.NewRecorder()
	s.Ping(rr, httptest.NewRequest(http.MethodGet, "/ping", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	if rr.Header().Get("X-Server-Time") == "" {
		t.Fatal("missing X-Server-Time")
	}
	if !strings.Contains(rr.Body.String(), `"pong":true`) {
		t.Fatalf("body=%s", rr.Body.String())
	}
}

func TestDownloadRequiresSession(t *testing.T) {
	s := testServer()
	rr := httptest.NewRecorder()
	s.Download(rr, httptest.NewRequest(http.MethodGet, "/download?size=1024", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d want 403", rr.Code)
	}

	beginSession(t, s, "s1")
	rr2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/download?size=1024", nil)
	req.Header.Set("X-Session-Id", "s1")
	s.Download(rr2, req)
	if rr2.Code != http.StatusOK {
		t.Fatalf("status=%d", rr2.Code)
	}
	if rr2.Body.Len() != 1024 {
		t.Fatalf("len=%d want 1024", rr2.Body.Len())
	}
}

func TestUpload(t *testing.T) {
	s := testServer()
	beginSession(t, s, "up")
	body := bytes.Repeat([]byte("x"), 2048)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/upload", bytes.NewReader(body))
	req.Header.Set("X-Session-Id", "up")
	s.Upload(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if int(resp["received"].(float64)) != 2048 {
		t.Fatalf("received=%v", resp["received"])
	}
}

func TestBeginConflict(t *testing.T) {
	s := testServer()
	begin := func(id string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		b, _ := json.Marshal(map[string]string{"sessionId": id})
		req := httptest.NewRequest(http.MethodPost, "/test/begin", bytes.NewReader(b))
		s.Begin(rr, req)
		return rr
	}
	if begin("a").Code != http.StatusOK {
		t.Fatal("first begin failed")
	}
	rr := begin("b")
	if rr.Code != http.StatusConflict {
		t.Fatalf("status=%d want 409", rr.Code)
	}

	endBody, _ := json.Marshal(map[string]string{"sessionId": "a"})
	endRR := httptest.NewRecorder()
	s.End(endRR, httptest.NewRequest(http.MethodPost, "/test/end", bytes.NewReader(endBody)))
	if endRR.Code != http.StatusOK {
		t.Fatal("end failed")
	}
	if begin("b").Code != http.StatusOK {
		t.Fatal("begin after end failed")
	}
}

func TestConfigMaxConcurrent(t *testing.T) {
	s := New(lock.New(2, time.Minute), 4, 2, 2)
	rr := httptest.NewRecorder()
	s.Config(rr, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	body := rr.Body.String()
	if !strings.Contains(body, `"maxConcurrent":2`) {
		t.Fatalf("body=%s", body)
	}
	if !strings.Contains(body, `"uploadStreams":2`) {
		t.Fatalf("missing uploadStreams: %s", body)
	}
}

func TestRoutesRegister(t *testing.T) {
	s := testServer()
	mux := http.NewServeMux()
	s.Routes(mux)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	res, err := http.Get(ts.URL + "/ping")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(b), "pong") {
		t.Fatalf("unexpected ping response")
	}
}

// A reader that delivers real payload and then fails before Content-Length.
type interruptedUpload struct{ sent bool }

func (r *interruptedUpload) Read(p []byte) (int, error) {
	if r.sent {
		return 0, io.ErrUnexpectedEOF
	}
	r.sent = true
	return copy(p, "partial bytes"), nil
}

func TestPartialUploadAccountingAndPhaseIsolation(t *testing.T) {
	s := testServer()
	beginSession(t, s, "partial")
	req := httptest.NewRequest(http.MethodPost, "/upload?phase=upload", &interruptedUpload{})
	req.Header.Set("X-Session-Id", "partial")
	rr := httptest.NewRecorder()
	s.Upload(rr, req)
	if rr.Code == 200 {
		t.Fatal("interrupted upload accepted")
	}
	req = httptest.NewRequest(http.MethodGet, "/test/stats?phase=upload", nil)
	req.Header.Set("X-Session-Id", "partial")
	rr = httptest.NewRecorder()
	s.Stats(rr, req)
	var stats lock.UploadStats
	if err := json.Unmarshal(rr.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || stats.Bytes != 13 || stats.Active != 0 {
		t.Fatalf("status %d stats %+v", rr.Code, stats)
	}
	other, ok := s.Lock.UploadStats("partial", 1)
	if !ok || other.Bytes != 0 {
		t.Fatal("upload leaked into bidirectional counters")
	}
	s.Lock.Release("partial")
	rr = httptest.NewRecorder()
	s.Stats(rr, req)
	if rr.Code != 403 {
		t.Fatal("released stats accessible")
	}
	beginSession(t, s, "partial")
	fresh, _ := s.Lock.UploadStats("partial", 0)
	if fresh.Bytes != 0 {
		t.Fatal("old counters survived release")
	}
}

func TestStatsValidation(t *testing.T) {
	s := testServer()
	beginSession(t, s, "s")
	for _, tc := range []struct {
		path, id string
		want     int
	}{
		{"/test/stats?phase=upload", "", 403},
		{"/test/stats?phase=invalid", "s", 400},
		{"/test/stats?phase=bidir", "s", 200},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		req.Header.Set("X-Session-Id", tc.id)
		rr := httptest.NewRecorder()
		s.Stats(rr, req)
		if rr.Code != tc.want {
			t.Fatalf("%s: %d want %d", tc.path, rr.Code, tc.want)
		}
	}
}

func TestDownloadReusedPayloadAndTail(t *testing.T) {
	s := testServer()
	beginSession(t, s, "payload")
	const size = 2*chunkSize + 17
	for i := 0; i < 2; i++ {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/download?size=%d", size), nil)
		req.Header.Set("X-Session-Id", "payload")
		s.Download(rr, req)
		data := rr.Body.Bytes()
		if rr.Code != http.StatusOK || len(data) != size {
			t.Fatalf("status=%d bytes=%d", rr.Code, len(data))
		}
		if !bytes.Equal(data[:chunkSize], data[chunkSize:2*chunkSize]) || !bytes.Equal(data[:17], data[2*chunkSize:]) {
			t.Fatal("payload or trailing bytes changed")
		}
		if !bytes.Equal(data[:chunkSize], s.downloadBuffer) {
			t.Fatal("shared payload changed")
		}
	}
}

type interruptedDownload struct {
	header http.Header
	writes int
	cancel context.CancelFunc
	fail   bool
}

func (w *interruptedDownload) Header() http.Header { return w.header }
func (w *interruptedDownload) WriteHeader(int)     {}
func (w *interruptedDownload) Write(p []byte) (int, error) {
	w.writes++
	if w.fail {
		return 0, io.ErrClosedPipe
	}
	w.cancel()
	return len(p), nil
}
func TestDownloadStopsOnCancellationOrWriteError(t *testing.T) {
	for _, fail := range []bool{false, true} {
		s := testServer()
		beginSession(t, s, "cancel")
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest(http.MethodGet, "/download?size=33554432", nil).WithContext(ctx)
		req.Header.Set("X-Session-Id", "cancel")
		w := &interruptedDownload{header: make(http.Header), cancel: cancel, fail: fail}
		s.Download(w, req)
		cancel()
		if w.writes != 1 {
			t.Fatalf("fail=%v writes=%d; continued after cancellation/error", fail, w.writes)
		}
	}
}
