package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/openwrt-builder/custom-bufferbloat/internal/metrics"
)

type probeStats struct {
	samples         []float64
	sampleTimes     []float64 // ms from phase start
	recoverySamples []float64 // failed attempts are NaN and break recovery streaks
	downBytes       int64
	upBytes         int64
	loadErrors      int64
	attempts        int
	failures        int
	successes       int // HTTP-successful probes
	rpmOK           int // successful and within latency SLA (RPM)
	duration        time.Duration
	stoppedAt       time.Time
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	baseURL := flag.String("url", "http://127.0.0.1:8080", "server base URL")
	jsonOut := flag.Bool("json", false, "print JSON result")
	downStreams := flag.Int("streams", 4, "starting download streams (warm-up may raise)")
	upStreams := flag.Int("upload-streams", 2, "parallel upload streams")
	flag.Parse()

	client := &http.Client{Timeout: 120 * time.Second}
	sessionID := fmt.Sprintf("cli-%d", time.Now().UnixNano())

	defer end(client, *baseURL, sessionID)
	if err := begin(ctx, client, *baseURL, sessionID); err != nil {
		return fmt.Errorf("begin: %w", err)
	}

	idle := sampleProbes(ctx, client, *baseURL, sessionID, 4*time.Second)
	idleP50 := metrics.Percentile(idle.samples, 50)

	streams, chunk := *downStreams, 1<<20
	if streams < 2 {
		streams = 2
	}
	bestStreams, bestChunk, bestMbps := streams, chunk, 0.0
	for step := 0; step < 3; step++ {
		b, dur, _ := runLoad(ctx, client, *baseURL, sessionID, streams, chunk, 2*time.Second, true, 80)
		mbps := metrics.Mbps(b, float64(dur.Milliseconds()))
		if mbps > bestMbps*1.05 {
			bestMbps = mbps
			bestStreams = streams
			bestChunk = chunk
			if streams < 6 {
				streams++
			}
			if chunk < 4<<20 {
				chunk += 512 << 10
			}
		} else {
			break
		}
	}
	// Drain after warm-up so scored phases are not polluted by leftover queues.
	_ = sampleProbes(ctx, client, *baseURL, sessionID, 2*time.Second)

	up := *upStreams
	if up > bestStreams {
		up = bestStreams
	}
	if up < 1 {
		up = 1
	}
	biDown := bestStreams / 2
	if biDown < 1 {
		biDown = 1
	}
	biUp := up
	if biUp > biDown {
		biUp = biDown
	}

	rpmBudget := idleP50 * 3
	if rpmBudget < 80 || rpmBudget != rpmBudget {
		rpmBudget = 80
	}

	downBytes, downDur, down := runLoad(ctx, client, *baseURL, sessionID, bestStreams, bestChunk, 8*time.Second, true, rpmBudget)
	_ = sampleProbes(ctx, client, *baseURL, sessionID, 1*time.Second)
	upBytes, upDur, upStats := runLoad(ctx, client, *baseURL, sessionID, up, bestChunk, 8*time.Second, false, rpmBudget)
	_ = sampleProbes(ctx, client, *baseURL, sessionID, 1*time.Second)
	biBytes, biDur, bi := runLoadBi(ctx, client, *baseURL, sessionID, biDown, biUp, bestChunk, 8*time.Second, rpmBudget)
	recoveryOffset := time.Since(bi.stoppedAt)
	recovery := sampleProbes(ctx, client, *baseURL, sessionID, 4*time.Second)
	for i := range recovery.sampleTimes {
		recovery.sampleTimes[i] += float64(recoveryOffset.Microseconds()) / 1000
	}

	downInc := metrics.Increase(idle.samples, down.samples)
	upInc := metrics.Increase(idle.samples, upStats.samples)
	biInc := metrics.Increase(idle.samples, bi.samples)
	if err := ctx.Err(); err != nil {
		return err
	}
	warnings := []string{}
	gDown := phaseGrade(idle, down, true, false, downInc, "download", &warnings)
	gUp := phaseGrade(idle, upStats, false, true, upInc, "upload", &warnings)
	gBi := phaseGrade(idle, bi, true, true, biInc, "bidirectional", &warnings)
	gAll := metrics.WorseGrades(gDown, gUp, gBi)

	recMs := metrics.RecoveryMsStable(recovery.recoverySamples, recovery.sampleTimes, idleP50, 5, 3)
	if idle.failures > 0 {
		warnings = append(warnings, "baseline: HTTP probe failures")
	}
	if math.IsNaN(recMs) {
		warnings = append(warnings, "recovery was not confirmed within the observation window")
	}

	result := map[string]any{
		"idle_p50_ms":         round1(idleP50),
		"idle_p95_ms":         round1(metrics.Percentile(idle.samples, 95)),
		"warmup_streams":      bestStreams,
		"warmup_chunk":        bestChunk,
		"warmup_mbps":         round1(bestMbps),
		"download_inc_ms":     round1(downInc),
		"download_mbps":       round1(metrics.Mbps(downBytes, float64(downDur.Milliseconds()))),
		"download_grade":      gDown,
		"download_loss_pct":   round1(metrics.LossPercent(down.failures, down.attempts)),
		"download_jitter_ms":  round1(metrics.JitterMs(down.samples)),
		"download_rpm":        round1(metrics.RPM(down.rpmOK, down.duration.Seconds())),
		"upload_inc_ms":       round1(upInc),
		"upload_mbps":         round1(metrics.Mbps(upBytes, float64(upDur.Milliseconds()))),
		"upload_grade":        gUp,
		"upload_loss_pct":     round1(metrics.LossPercent(upStats.failures, upStats.attempts)),
		"upload_jitter_ms":    round1(metrics.JitterMs(upStats.samples)),
		"upload_rpm":          round1(metrics.RPM(upStats.rpmOK, upStats.duration.Seconds())),
		"bidir_inc_ms":        round1(biInc),
		"bidir_mbps":          round1(metrics.Mbps(biBytes, float64(biDur.Milliseconds()))),
		"bidir_grade":         gBi,
		"bidir_loss_pct":      round1(metrics.LossPercent(bi.failures, bi.attempts)),
		"bidir_jitter_ms":     round1(metrics.JitterMs(bi.samples)),
		"bidir_rpm":           round1(metrics.RPM(bi.rpmOK, bi.duration.Seconds())),
		"recovery_ms":         round1(recMs),
		"recovery_p50_ms":     round1(metrics.Percentile(recovery.samples, 50)),
		"overall_grade":       gAll,
		"quality_warnings":    warnings,
		"bidir_download_mbps": round1(metrics.Mbps(bi.downBytes, float64(biDur.Milliseconds()))),
		"bidir_upload_mbps":   round1(metrics.Mbps(bi.upBytes, float64(biDur.Milliseconds()))),
	}

	if *jsonOut {
		return writeResult(os.Stdout, result)
	}
	for _, warning := range warnings {
		fmt.Fprintln(os.Stderr, "Warning:", warning)
	}

	fmt.Printf("Overall: %s  (down %s / up %s / both %s)\n", gAll, gDown, gUp, gBi)
	fmt.Printf("Warm-up: %d streams · %.0f Mbps\n", bestStreams, bestMbps)
	fmt.Printf("Down: +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n",
		downInc, result["download_mbps"], result["download_loss_pct"], result["download_jitter_ms"], result["download_rpm"])
	fmt.Printf("Up:   +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n",
		upInc, result["upload_mbps"], result["upload_loss_pct"], result["upload_jitter_ms"], result["upload_rpm"])
	fmt.Printf("Both: +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n",
		biInc, result["bidir_mbps"], result["bidir_loss_pct"], result["bidir_jitter_ms"], result["bidir_rpm"])
	fmt.Printf("Both directions: down %.1f Mbps / up %.1f Mbps\n", result["bidir_download_mbps"], result["bidir_upload_mbps"])
	if recMs != recMs { // NaN
		fmt.Printf("Recovery: did not return to idle+5ms within window\n")
	} else {
		fmt.Printf("Recovery: %.0f ms to near-idle (p50 %.1f ms)\n", recMs, result["recovery_p50_ms"])
	}
	return nil
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func writeResult(w io.Writer, result map[string]any) error {
	for key, value := range result {
		if v, ok := value.(float64); ok && (math.IsNaN(v) || math.IsInf(v, 0)) {
			result[key] = nil
		}
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(result)
}

func phaseGrade(idle, loaded probeStats, down, up bool, increase float64, name string, warnings *[]string) string {
	valid := len(idle.samples) >= 5 && len(loaded.samples) >= 5 && loaded.loadErrors == 0 && (!down || loaded.downBytes > 0) && (!up || loaded.upBytes > 0)
	if !valid {
		*warnings = append(*warnings, name+": incomplete load or fewer than 5 latency samples; grade withheld")
		return "—"
	}
	if loaded.failures > 0 {
		*warnings = append(*warnings, name+": HTTP probe failures; grade uses successful probes only")
	}
	return metrics.Grade(increase)
}

func begin(ctx context.Context, c *http.Client, base, id string) error {
	body, _ := json.Marshal(map[string]string{"sessionId": id})
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/test/begin", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusConflict {
		return fmt.Errorf("server busy (409)")
	}
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		return fmt.Errorf("status %d: %s", res.StatusCode, b)
	}
	return nil
}

func end(c *http.Client, base, id string) {
	body, _ := json.Marshal(map[string]string{"sessionId": id})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/test/end", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err == nil {
		res.Body.Close()
	}
}

func ping(ctx context.Context, c *http.Client, base, sessionID string) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	t0 := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/ping", nil)
	if err != nil {
		return 0, err
	}
	if sessionID != "" {
		req.Header.Set("X-Session-Id", sessionID)
	}
	res, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if _, err := io.Copy(io.Discard, res.Body); err != nil {
		return 0, err
	}
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("status %d", res.StatusCode)
	}
	return float64(time.Since(t0).Microseconds()) / 1000, nil
}

func pause(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func sampleProbes(parent context.Context, c *http.Client, base, sessionID string, d time.Duration) probeStats {
	ctx, cancel := context.WithTimeout(parent, d)
	defer cancel()
	return collectProbes(ctx, c, base, sessionID, 0)
}

func collectProbes(ctx context.Context, c *http.Client, base, sessionID string, rpmBudget float64) probeStats {
	var st probeStats
	t0 := time.Now()
	for ctx.Err() == nil {
		ms, err := ping(ctx, c, base, sessionID)
		if ctx.Err() != nil {
			break
		} // phase cancellation is not probe loss
		st.attempts++
		st.sampleTimes = append(st.sampleTimes, float64(time.Since(t0).Microseconds())/1000)
		if err == nil {
			st.samples = append(st.samples, ms)
			st.recoverySamples = append(st.recoverySamples, ms)
			st.successes++
			if ms <= rpmBudget {
				st.rpmOK++
			}
		} else {
			st.failures++
			st.recoverySamples = append(st.recoverySamples, math.NaN())
		}
		pause(ctx, 200*time.Millisecond)
	}
	st.duration = time.Since(t0)
	return st
}

func runLoad(ctx context.Context, c *http.Client, base, sessionID string, streams, chunk int, d time.Duration, download bool, rpmBudget float64) (int64, time.Duration, probeStats) {
	if download {
		return runLoadBi(ctx, c, base, sessionID, streams, 0, chunk, d, rpmBudget)
	}
	return runLoadBi(ctx, c, base, sessionID, 0, streams, chunk, d, rpmBudget)
}

func readUploadStats(ctx context.Context, c *http.Client, base, id, phase string) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/test/stats?phase="+phase, nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("X-Session-Id", id)
		res, err := c.Do(req)
		if err != nil {
			return 0, err
		}
		var stats struct {
			Bytes  int64
			Active int
		}
		err = json.NewDecoder(res.Body).Decode(&stats)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("upload stats: status %d", res.StatusCode)
		}
		if err != nil {
			return 0, err
		}
		if stats.Active == 0 {
			return stats.Bytes, nil
		}
		pause(ctx, 20*time.Millisecond)
	}
}

func runLoadBi(parent context.Context, c *http.Client, base, sessionID string, downStreams, upStreams, chunk int, d time.Duration, rpmBudget float64) (int64, time.Duration, probeStats) {
	ctx, cancel := context.WithTimeout(parent, d)
	defer cancel()
	var downloaded, loadErrors atomic.Int64
	var wg sync.WaitGroup
	payload := make([]byte, chunk)
	_, _ = rand.Read(payload)
	phase := "upload"
	if downStreams > 0 && upStreams > 0 {
		phase = "bidir"
	}
	startWorkers := func(download bool, n int) {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for ctx.Err() == nil {
					method, url := http.MethodGet, fmt.Sprintf("%s/download?size=%d", base, chunk)
					var body io.Reader
					if !download {
						method, url, body = http.MethodPost, base+"/upload?phase="+phase, bytes.NewReader(payload)
					}
					req, err := http.NewRequestWithContext(ctx, method, url, body)
					if err == nil {
						req.Header.Set("X-Session-Id", sessionID)
						if !download {
							req.Header.Set("Content-Type", "application/octet-stream")
						}
						var res *http.Response
						res, err = c.Do(req)
						if err == nil {
							var n int64
							n, err = io.Copy(io.Discard, res.Body)
							res.Body.Close()
							if res.StatusCode != http.StatusOK {
								err = fmt.Errorf("load status %d", res.StatusCode)
							} else if download {
								downloaded.Add(n)
							}
						}
					}
					if err != nil && ctx.Err() == nil {
						loadErrors.Add(1)
						pause(ctx, 100*time.Millisecond)
					}
				}
			}()
		}
	}
	t0 := time.Now()
	startWorkers(true, downStreams)
	startWorkers(false, upStreams)
	st := collectProbes(ctx, c, base, sessionID, rpmBudget)
	cancel()
	wg.Wait()
	st.stoppedAt = time.Now()
	st.duration = st.stoppedAt.Sub(t0)
	st.downBytes = downloaded.Load()
	if upStreams > 0 && parent.Err() == nil {
		var err error
		st.upBytes, err = readUploadStats(parent, c, base, sessionID, phase)
		if err != nil {
			loadErrors.Add(1)
		}
	}
	st.loadErrors = loadErrors.Load()
	return st.downBytes + st.upBytes, st.duration, st
}
