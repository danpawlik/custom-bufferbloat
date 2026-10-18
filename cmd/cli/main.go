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
	"strings"
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
	repeat := flag.Bool("repeat", false, "run three tests with 10-second cooldowns")
	expectedDown := flag.Float64("expected-download", 0, "expected download Mbps (0 disables comparison)")
	expectedUp := flag.Float64("expected-upload", 0, "expected upload Mbps (0 disables comparison)")
	flag.Parse()
	for _, speed := range []float64{*expectedDown, *expectedUp} {
		if speed < 0 || math.IsNaN(speed) || math.IsInf(speed, 0) {
			return fmt.Errorf("expected speeds must be finite and nonnegative")
		}
	}
	if *downStreams < 1 || *downStreams > 5 || *upStreams < 1 || *upStreams > 3 {
		return fmt.Errorf("streams must be 1–5 for download and 1–3 for upload")
	}

	client := &http.Client{Timeout: 120 * time.Second}
	count := 1
	if *repeat {
		count = 3
	}
	runs, runErr := repeatRuns(ctx, count, 10*time.Second, func(index int) (map[string]any, error) {
		if *repeat {
			fmt.Fprintf(os.Stderr, "Run %d/%d (10-second cooldown between runs)\n", index+1, count)
		}
		return runOnce(ctx, client, *baseURL, *downStreams, *upStreams, *expectedDown, *expectedUp)
	})
	if len(runs) == 0 {
		return runErr
	}
	if *jsonOut {
		result := runs[0]
		if *repeat {
			result = map[string]any{"requested_runs": count, "completed_runs": len(runs), "runs": runs, "summary": summarizeRuns(runs)}
		}
		if err := writeResult(os.Stdout, result); err != nil {
			return err
		}
	} else {
		for i, result := range runs {
			if *repeat {
				fmt.Printf("Run %d/%d\n", i+1, count)
			}
			printResult(result)
		}
		if *repeat {
			fmt.Printf("Repeat summary: %d/%d completed; only runs with valid overall grades are included.\n", len(runs), count)
			summary := summarizeRuns(runs)
			for _, key := range summaryKeys {
				if value, ok := summary[key]; ok {
					fmt.Printf("%s: median %.1f · min %.1f · max %.1f · spread %.1f (n=%d)\n", key, value.Median, value.Min, value.Max, value.Spread, value.Count)
				}
			}
			if len(summary) == 0 {
				fmt.Println("No valid runs to summarize.")
			}
		}
	}
	return runErr
}

func repeatRuns(ctx context.Context, count int, cooldown time.Duration, once func(int) (map[string]any, error)) ([]map[string]any, error) {
	runs := []map[string]any{}
	for i := 0; i < count; i++ {
		if i > 0 {
			pause(ctx, cooldown)
		}
		if err := ctx.Err(); err != nil {
			return runs, err
		}
		result, err := once(i)
		if err != nil {
			return runs, err
		}
		runs = append(runs, result)
	}
	return runs, nil
}

var summaryKeys = []string{"idle_p50_ms", "download_mbps", "upload_mbps", "download_inc_ms", "upload_inc_ms", "bidir_inc_ms", "bidir_download_mbps", "bidir_upload_mbps", "download_loss_pct", "upload_loss_pct", "bidir_loss_pct", "recovery_ms"}

func summarizeRuns(runs []map[string]any) map[string]metrics.Spread {
	summary := map[string]metrics.Spread{}
	for _, key := range summaryKeys {
		values := []float64{}
		for _, run := range runs {
			grade, ok := run["overall_grade"].(string)
			if !ok || grade == "—" {
				continue
			}
			if value, ok := run[key].(float64); ok {
				values = append(values, value)
			}
		}
		if spread, ok := metrics.Summarize(values); ok {
			summary[key] = spread
		}
	}
	return summary
}

func runOnce(ctx context.Context, client *http.Client, baseURL string, downStreams, upStreams int, expectedDown, expectedUp float64) (map[string]any, error) {
	sessionID := fmt.Sprintf("cli-%d", time.Now().UnixNano())
	defer end(client, baseURL, sessionID)
	if err := begin(ctx, client, baseURL, sessionID); err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	idle := sampleProbes(ctx, client, baseURL, sessionID, 4*time.Second)
	idleP50 := metrics.Percentile(idle.samples, 50)

	downCalibration := calibrate(ctx, client, baseURL, sessionID, downStreams, true)
	_ = sampleProbes(ctx, client, baseURL, sessionID, time.Second)
	upCalibration := calibrate(ctx, client, baseURL, sessionID, upStreams, false)
	_ = sampleProbes(ctx, client, baseURL, sessionID, 2*time.Second)
	bestStreams, bestChunk, bestMbps := downCalibration.streams, downCalibration.chunk, downCalibration.mbps
	up := upCalibration.streams
	biDown := (bestStreams + 1) / 2
	biUp := min(up, 5-biDown)

	rpmBudget := idleP50 * 3
	if rpmBudget < 80 || rpmBudget != rpmBudget {
		rpmBudget = 80
	}

	downBytes, downDur, down := runLoad(ctx, client, baseURL, sessionID, bestStreams, bestChunk, 8*time.Second, true, rpmBudget)
	_ = sampleProbes(ctx, client, baseURL, sessionID, 1*time.Second)
	upBytes, upDur, upStats := runLoad(ctx, client, baseURL, sessionID, up, upCalibration.chunk, 8*time.Second, false, rpmBudget)
	_ = sampleProbes(ctx, client, baseURL, sessionID, 1*time.Second)
	biBytes, biDur, bi := runLoadBi(ctx, client, baseURL, sessionID, biDown, biUp, bestChunk, upCalibration.chunk, 8*time.Second, rpmBudget)
	recoveryOffset := time.Since(bi.stoppedAt)
	recovery := sampleProbes(ctx, client, baseURL, sessionID, 4*time.Second)
	for i := range recovery.sampleTimes {
		recovery.sampleTimes[i] += float64(recoveryOffset.Microseconds()) / 1000
	}

	downInc := metrics.Increase(idle.samples, down.samples)
	upInc := metrics.Increase(idle.samples, upStats.samples)
	biInc := metrics.Increase(idle.samples, bi.samples)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	warnings := []string{}
	gDown := phaseGrade(idle, down, true, false, downInc, "download", &warnings)
	gUp := phaseGrade(idle, upStats, false, true, upInc, "upload", &warnings)
	gBi := phaseGrade(idle, bi, true, true, biInc, "bidirectional", &warnings)
	downWarnings := metrics.SaturationWarnings(downCalibration.status, metrics.Mbps(downBytes, float64(downDur.Milliseconds())), expectedDown)
	upWarnings := metrics.SaturationWarnings(upCalibration.status, metrics.Mbps(upBytes, float64(upDur.Milliseconds())), expectedUp)
	gAll := metrics.WorseGrades(gDown, gUp, gBi)

	recMs := metrics.RecoveryMsStable(recovery.recoverySamples, recovery.sampleTimes, idleP50, 5, 3)
	if idle.failures > 0 {
		warnings = append(warnings, "baseline: HTTP probe failures")
	}
	if math.IsNaN(recMs) {
		warnings = append(warnings, "recovery was not confirmed within the observation window")
	}

	result := map[string]any{
		"idle_p50_ms":            round1(idleP50),
		"idle_p95_ms":            round1(metrics.Percentile(idle.samples, 95)),
		"warmup_streams":         bestStreams,
		"warmup_chunk":           bestChunk,
		"warmup_mbps":            round1(bestMbps),
		"upload_warmup_streams":  upCalibration.streams,
		"upload_warmup_chunk":    upCalibration.chunk,
		"upload_warmup_mbps":     round1(upCalibration.mbps),
		"download_calibration":   downCalibration.status,
		"upload_calibration":     upCalibration.status,
		"expected_download_mbps": expectedDown,
		"expected_upload_mbps":   expectedUp,
		"download_advisory":      strings.Join(downWarnings, " "),
		"upload_advisory":        strings.Join(upWarnings, " "),
		"download_inc_ms":        round1(downInc),
		"download_mbps":          round1(metrics.Mbps(downBytes, float64(downDur.Milliseconds()))),
		"download_grade":         gDown,
		"download_loss_pct":      round1(metrics.LossPercent(down.failures, down.attempts)),
		"download_jitter_ms":     round1(metrics.JitterMs(down.samples)),
		"download_rpm":           round1(metrics.RPM(down.rpmOK, down.duration.Seconds())),
		"upload_inc_ms":          round1(upInc),
		"upload_mbps":            round1(metrics.Mbps(upBytes, float64(upDur.Milliseconds()))),
		"upload_grade":           gUp,
		"upload_loss_pct":        round1(metrics.LossPercent(upStats.failures, upStats.attempts)),
		"upload_jitter_ms":       round1(metrics.JitterMs(upStats.samples)),
		"upload_rpm":             round1(metrics.RPM(upStats.rpmOK, upStats.duration.Seconds())),
		"bidir_inc_ms":           round1(biInc),
		"bidir_mbps":             round1(metrics.Mbps(biBytes, float64(biDur.Milliseconds()))),
		"bidir_grade":            gBi,
		"bidir_loss_pct":         round1(metrics.LossPercent(bi.failures, bi.attempts)),
		"bidir_jitter_ms":        round1(metrics.JitterMs(bi.samples)),
		"bidir_rpm":              round1(metrics.RPM(bi.rpmOK, bi.duration.Seconds())),
		"recovery_ms":            round1(recMs),
		"recovery_p50_ms":        round1(metrics.Percentile(recovery.samples, 50)),
		"overall_grade":          gAll,
		"quality_warnings":       warnings,
		"bidir_download_mbps":    round1(metrics.Mbps(bi.downBytes, float64(biDur.Milliseconds()))),
		"bidir_upload_mbps":      round1(metrics.Mbps(bi.upBytes, float64(biDur.Milliseconds()))),
	}

	return result, nil
}

func printResult(result map[string]any) {
	for _, warning := range result["quality_warnings"].([]string) {
		fmt.Fprintln(os.Stderr, "Warning:", warning)
	}
	fmt.Printf("Overall: %s (down %s / up %s / both %s)\n", result["overall_grade"], result["download_grade"], result["upload_grade"], result["bidir_grade"])
	fmt.Printf("Calibration: down %s at %.1f Mbps; up %s at %.1f Mbps\n", result["download_calibration"], result["warmup_mbps"], result["upload_calibration"], result["upload_warmup_mbps"])
	for _, direction := range []string{"download", "upload"} {
		if note, ok := result[direction+"_advisory"].(string); ok && note != "" {
			fmt.Printf("%s speed note: %s\n", direction, note)
		}
	}
	for _, direction := range []string{"download", "upload", "bidir"} {
		fmt.Printf("%s: +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n", direction, result[direction+"_inc_ms"], result[direction+"_mbps"], result[direction+"_loss_pct"], result[direction+"_jitter_ms"], result[direction+"_rpm"])
	}
	fmt.Printf("Both directions: down %.1f Mbps / up %.1f Mbps\n", result["bidir_download_mbps"], result["bidir_upload_mbps"])
	if math.IsNaN(result["recovery_ms"].(float64)) {
		fmt.Println("Recovery: not confirmed within observation window")
	} else {
		fmt.Printf("Recovery: %.1f ms\n", result["recovery_ms"])
	}
}

type calibration struct {
	streams, chunk int
	mbps           float64
	status         string
}

func calibrate(ctx context.Context, c *http.Client, base, id string, streams int, download bool) calibration {
	chunk, maxStreams := 4<<20, 3
	if download {
		chunk, maxStreams = 8<<20, 5
	}
	streams = max(1, min(streams, maxStreams))
	best := calibration{streams: streams, chunk: chunk, status: "unconfirmed"}
	speeds := []float64{}
	failed := false
	for step := 0; step < 3 && ctx.Err() == nil; step++ {
		bytes, duration, stats := runLoad(ctx, c, base, id, streams, chunk, 2*time.Second, download, 80)
		speed := metrics.Mbps(bytes, float64(duration.Milliseconds()))
		if stats.loadErrors > 0 {
			speed = math.NaN()
			failed = true
		}
		speeds = append(speeds, speed)
		if speed > best.mbps {
			best.mbps = speed
			best.streams = streams
			best.chunk = chunk
		}
		best.status = metrics.CalibrationStatus(speeds)
		if best.status == "plateau" {
			break
		}
		streams = min(maxStreams, streams+1)
		chunk *= 2
	}
	if failed {
		best.status = "unconfirmed"
	}
	return best
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func writeResult(w io.Writer, result map[string]any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(jsonSafe(result))
}

func jsonSafe(value any) any {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
	case map[string]any:
		clean := make(map[string]any, len(v))
		for key, item := range v {
			clean[key] = jsonSafe(item)
		}
		return clean
	case []map[string]any:
		clean := make([]any, len(v))
		for i, item := range v {
			clean[i] = jsonSafe(item)
		}
		return clean
	}
	return value
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
		return runLoadBi(ctx, c, base, sessionID, streams, 0, chunk, chunk, d, rpmBudget)
	}
	return runLoadBi(ctx, c, base, sessionID, 0, streams, chunk, chunk, d, rpmBudget)
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

func runLoadBi(parent context.Context, c *http.Client, base, sessionID string, downStreams, upStreams, chunk, uploadChunk int, d time.Duration, rpmBudget float64) (int64, time.Duration, probeStats) {
	phase := "upload"
	if downStreams > 0 && upStreams > 0 {
		phase = "bidir"
	}
	var uploadStart int64
	if upStreams > 0 && parent.Err() == nil {
		var err error
		uploadStart, err = readUploadStats(parent, c, base, sessionID, phase)
		if err != nil {
			return 0, 0, probeStats{loadErrors: 1, stoppedAt: time.Now()}
		}
	}
	var downloaded, loadErrors atomic.Int64
	var wg sync.WaitGroup
	var payload []byte
	if upStreams > 0 {
		payload = make([]byte, uploadChunk)
		if _, err := rand.Read(payload); err != nil {
			return 0, 0, probeStats{loadErrors: 1, stoppedAt: time.Now()}
		}
	}
	ctx, cancel := context.WithTimeout(parent, d)
	defer cancel()
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
		st.upBytes -= uploadStart
		if st.upBytes < 0 {
			err = fmt.Errorf("upload counter decreased")
			st.upBytes = 0
		}
		if err != nil {
			loadErrors.Add(1)
		}
	}
	st.loadErrors = loadErrors.Load()
	return st.downBytes + st.upBytes, st.duration, st
}
