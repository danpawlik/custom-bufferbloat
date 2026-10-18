package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/openwrt-builder/custom-bufferbloat/internal/metrics"
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
	var cancelled, snapshots atomic.Int64
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/test/stats" {
			if snapshots.Add(1) == 1 {
				return response(200, `{"bytes":8192,"active":0}`), nil
			}
			return response(200, `{"bytes":12288,"active":0}`), nil
		}
		<-r.Context().Done()
		cancelled.Add(1)
		return nil, r.Context().Err()
	})}
	start := time.Now()
	_, duration, stats := runLoadBi(context.Background(), c, "http://test", "s", 1, 1, 1024, 1024, 50*time.Millisecond, 80)
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
	_, _, stats := runLoadBi(context.Background(), c, "http://test", "s", 1, 0, 1024, 1024, 50*time.Millisecond, 80)
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
	runLoadBi(ctx, c, "http://test", "s", 1, 1, 1024, 1024, 8*time.Second, 80)
	end(c, "http://test", "s")
	if !ended || time.Since(start) > time.Second {
		t.Fatal("cleanup failed")
	}
}

func TestRepeatRunsAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	start := time.Now()
	runs, err := repeatRuns(ctx, 3, 10*time.Second, func(index int) (map[string]any, error) {
		calls++
		cancel()
		return map[string]any{"index": index}, nil
	})
	if err != context.Canceled || calls != 1 || len(runs) != 1 || time.Since(start) > time.Second {
		t.Fatalf("runs=%v err=%v calls=%d", runs, err, calls)
	}
	runs, err = repeatRuns(context.Background(), 3, 10*time.Millisecond, func(index int) (map[string]any, error) { return map[string]any{"index": index}, nil })
	if err != nil || len(runs) != 3 || runs[2]["index"] != 2 {
		t.Fatalf("%v %v", runs, err)
	}
	runs, err = repeatRuns(context.Background(), 3, 0, func(index int) (map[string]any, error) {
		if index == 1 {
			return nil, errors.New("busy")
		}
		return map[string]any{"index": index}, nil
	})
	if err == nil || len(runs) != 1 {
		t.Fatal("failed repeat lost completed run or continued")
	}
}

func TestRepeatSummaryExcludesInvalidRunsAndNestedJSONIsSafe(t *testing.T) {
	runs := []map[string]any{
		{"overall_grade": "A+", "download_mbps": 10.0, "recovery_ms": math.NaN()},
		{"overall_grade": "A", "download_mbps": 20.0, "recovery_ms": 200.0},
		{"overall_grade": "—", "download_mbps": 999.0, "recovery_ms": 0.0},
	}
	summary := summarizeRuns(runs)
	if got := summary["download_mbps"]; got.Count != 2 || got.Median != 15 || got.Spread != 10 {
		t.Fatalf("%+v", got)
	}
	if summary["recovery_ms"].Count != 1 {
		t.Fatal("missing recovery treated as zero")
	}
	var out bytes.Buffer
	if err := writeResult(&out, map[string]any{"runs": runs, "summary": summary}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"recovery_ms": null`) {
		t.Fatal(out.String())
	}
	if !math.IsNaN(runs[0]["recovery_ms"].(float64)) {
		t.Fatal("export mutated measurements")
	}
}

func TestUploadCounterDecreaseInvalidatesPhase(t *testing.T) {
	var snapshots atomic.Int64
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/test/stats" {
			if snapshots.Add(1) == 1 {
				return response(200, `{"bytes":1000,"active":0}`), nil
			}
			return response(200, `{"bytes":0,"active":0}`), nil
		}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	_, _, stats := runLoadBi(context.Background(), c, "http://test", "s", 0, 1, 1024, 1024, 20*time.Millisecond, 80)
	if stats.upBytes != 0 || stats.loadErrors == 0 {
		t.Fatalf("%+v", stats)
	}
}

func TestBidirectionalLoadUsesIndependentChunkSizes(t *testing.T) {
	var downSize, upSize atomic.Int64
	c := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/test/stats":
			return response(200, `{"bytes":0,"active":0}`), nil
		case "/download":
			if r.URL.Query().Get("size") == "1048576" {
				downSize.Store(1048576)
			}
		case "/upload":
			body, _ := io.ReadAll(r.Body)
			upSize.Store(int64(len(body)))
		}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	runLoadBi(context.Background(), c, "http://test", "s", 1, 1, 1<<20, 64<<10, 50*time.Millisecond, 80)
	if downSize.Load() != 1<<20 || upSize.Load() != 64<<10 {
		t.Fatalf("down=%d up=%d", downSize.Load(), upSize.Load())
	}
}

func TestCalibrationAdvisoryKeepsValidGradeAndRepeatSummary(t *testing.T) {
	good := probeStats{samples: []float64{10, 10, 10, 10, 10}, downBytes: 100, upBytes: 100}
	warnings := []string{}
	grade := phaseGrade(good, good, true, true, 0, "both", &warnings)
	advice := strings.Join(metrics.SaturationWarnings("rising", 50, 100), " ")
	if grade != "A+" || len(warnings) != 0 || strings.Contains(advice, "withheld") {
		t.Fatalf("grade=%s warnings=%v advice=%s", grade, warnings, advice)
	}
	result := map[string]any{"overall_grade": grade, "download_mbps": 50.0, "download_advisory": advice}
	if summarizeRuns([]map[string]any{result})["download_mbps"].Count != 1 {
		t.Fatal("advisory run excluded")
	}
}
