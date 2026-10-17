package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openwrt-builder/custom-bufferbloat/internal/lock"
)

func testServer() *Server {
	return New(lock.New(1, time.Minute), 4, 1)
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
	s := New(lock.New(2, time.Minute), 4, 2)
	rr := httptest.NewRecorder()
	s.Config(rr, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if !strings.Contains(rr.Body.String(), `"maxConcurrent":2`) {
		t.Fatalf("body=%s", rr.Body.String())
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
