package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestJSONUnavailableMetricsAndWriteError(t *testing.T) {
	var out bytes.Buffer
	if err := writeResult(&out, map[string]any{"recovery_ms": math.NaN(), "speed": math.Inf(1), "grade": "A"}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["recovery_ms"] != nil || got["speed"] != nil || got["grade"] != "A" {
		t.Fatalf("%v", got)
	}
	if err := writeResult(brokenWriter{}, map[string]any{"value": 1}); err == nil {
		t.Fatal("write error lost")
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, errors.New("disk full") }

func TestPhaseDeadlineCancelsLoadAndProbe(t *testing.T) {
	var cancelled atomic.Int64
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/test/stats" {
			return response(200, `{"bytes":4096,"active":0}`), nil
		}
		<-r.Context().Done()
		cancelled.Add(1)
		return nil, r.Context().Err()
	})}
	start := time.Now()
	_, duration, stats := runLoadBi(context.Background(), c, "http://test", "s", 1, 1, 1024, 50*time.Millisecond, 80)
	if time.Since(start) > time.Second || duration > time.Second {
		t.Fatal("phase failed to cancel promptly")
	}
	if cancelled.Load() != 3 {
		t.Fatalf("cancelled %d requests, want 3", cancelled.Load())
	}
	if stats.upBytes != 4096 || stats.failures != 0 || stats.loadErrors != 0 {
		t.Fatalf("%+v", stats)
	}
}

func TestFailedLoadWithholdsGrade(t *testing.T) {
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/download" {
			return response(403, "forbidden"), nil
		}
		return response(200, `{"pong":true}`), nil
	})}
	_, _, stats := runLoadBi(context.Background(), c, "http://test", "s", 1, 0, 1024, 50*time.Millisecond, 80)
	if stats.downBytes != 0 || stats.loadErrors == 0 {
		t.Fatalf("%+v", stats)
	}
	good := probeStats{samples: []float64{10, 10, 10, 10, 10}, downBytes: 100, upBytes: 100}
	cases := []struct {
		name  string
		stats probeStats
		want  string
	}{
		{"healthy", good, "A+"},
		{"no upload", probeStats{samples: good.samples, downBytes: 100}, "—"},
		{"no download", probeStats{samples: good.samples, upBytes: 100}, "—"},
		{"load error", probeStats{samples: good.samples, downBytes: 100, upBytes: 100, loadErrors: 1}, "—"},
		{"too few probes", probeStats{samples: []float64{10}, downBytes: 100, upBytes: 100}, "—"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			warnings := []string{}
			if got := phaseGrade(good, tc.stats, true, true, 0, "both", &warnings); got != tc.want {
				t.Fatalf("grade=%s", got)
			}
			if tc.want == "—" && len(warnings) == 0 {
				t.Fatal("missing quality warning")
			}
		})
	}
}

func TestProbeFailuresPreservedForRecovery(t *testing.T) {
	calls := 0
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("network failed")
		}
		return response(200, `{}`), nil
	})}
	stats := sampleProbes(context.Background(), c, "http://test", "s", 450*time.Millisecond)
	if len(stats.recoverySamples) != 3 || !math.IsNaN(stats.recoverySamples[1]) || len(stats.samples) != 2 || len(stats.sampleTimes) != 3 {
		t.Fatalf("%+v", stats)
	}
}

func TestCancelledParentAndIndependentCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var ended bool
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/test/end" {
			ended = r.Context().Err() == nil
			return response(200, `{}`), nil
		}
		t.Errorf("request after cancellation: %s", r.URL.Path)
		return nil, context.Canceled
	})}
	start := time.Now()
	runLoadBi(ctx, c, "http://test", "s", 1, 1, 1024, 8*time.Second, 80)
	end(c, "http://test", "s")
	if !ended || time.Since(start) > time.Second {
		t.Fatal("cleanup failed")
	}
}
