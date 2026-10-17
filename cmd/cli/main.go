package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/openwrt-builder/custom-bufferbloat/internal/metrics"
)

type probeStats struct {
	samples     []float64
	sampleTimes []float64 // ms from phase start
	attempts    int
	failures    int
	successes   int // HTTP-successful probes
	rpmOK       int // successful and within latency SLA (RPM)
	duration    time.Duration
}

func main() {
	baseURL := flag.String("url", "http://127.0.0.1:8080", "server base URL")
	jsonOut := flag.Bool("json", false, "print JSON result")
	downStreams := flag.Int("streams", 4, "starting download streams (warm-up may raise)")
	upStreams := flag.Int("upload-streams", 2, "parallel upload streams")
	flag.Parse()

	client := &http.Client{Timeout: 120 * time.Second}
	sessionID := fmt.Sprintf("cli-%d", time.Now().UnixNano())

	if err := begin(client, *baseURL, sessionID); err != nil {
		fmt.Fprintf(os.Stderr, "begin: %v\n", err)
		os.Exit(1)
	}
	defer end(client, *baseURL, sessionID)

	idle := sampleProbes(client, *baseURL, sessionID, 4*time.Second)
	idleP50 := metrics.Percentile(idle.samples, 50)

	streams, chunk := *downStreams, 1<<20
	if streams < 2 {
		streams = 2
	}
	bestStreams, bestChunk, bestMbps := streams, chunk, 0.0
	for step := 0; step < 3; step++ {
		b, dur, _ := runLoad(client, *baseURL, sessionID, streams, chunk, 2*time.Second, true, false, 80)
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
	_ = sampleProbes(client, *baseURL, sessionID, 2*time.Second)

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

	downBytes, downDur, down := runLoad(client, *baseURL, sessionID, bestStreams, bestChunk, 8*time.Second, true, false, rpmBudget)
	_ = sampleProbes(client, *baseURL, sessionID, 1*time.Second)
	upBytes, upDur, upStats := runLoad(client, *baseURL, sessionID, up, bestChunk, 8*time.Second, false, false, rpmBudget)
	_ = sampleProbes(client, *baseURL, sessionID, 1*time.Second)
	biBytes, biDur, bi := runLoadBi(client, *baseURL, sessionID, biDown, biUp, bestChunk, 8*time.Second, rpmBudget)
	recovery := sampleProbes(client, *baseURL, sessionID, 4*time.Second)

	downInc := metrics.Increase(idle.samples, down.samples)
	upInc := metrics.Increase(idle.samples, upStats.samples)
	biInc := metrics.Increase(idle.samples, bi.samples)
	gDown := metrics.Grade(downInc)
	gUp := metrics.Grade(upInc)
	gBi := metrics.Grade(biInc)
	gAll := metrics.WorseGrades(gDown, gUp, gBi)

	recMs := metrics.RecoveryMsStable(recovery.samples, recovery.sampleTimes, idleP50, 5, 3)

	result := map[string]any{
		"idle_p50_ms":        round1(idleP50),
		"idle_p95_ms":        round1(metrics.Percentile(idle.samples, 95)),
		"warmup_streams":     bestStreams,
		"warmup_chunk":       bestChunk,
		"warmup_mbps":        round1(bestMbps),
		"download_inc_ms":    round1(downInc),
		"download_mbps":      round1(metrics.Mbps(downBytes, float64(downDur.Milliseconds()))),
		"download_grade":     gDown,
		"download_loss_pct":  round1(metrics.LossPercent(down.failures, down.attempts)),
		"download_jitter_ms": round1(metrics.JitterMs(down.samples)),
		"download_rpm":       round1(metrics.RPM(down.rpmOK, down.duration.Seconds())),
		"upload_inc_ms":      round1(upInc),
		"upload_mbps":        round1(metrics.Mbps(upBytes, float64(upDur.Milliseconds()))),
		"upload_grade":       gUp,
		"upload_loss_pct":    round1(metrics.LossPercent(upStats.failures, upStats.attempts)),
		"upload_jitter_ms":   round1(metrics.JitterMs(upStats.samples)),
		"upload_rpm":         round1(metrics.RPM(upStats.rpmOK, upStats.duration.Seconds())),
		"bidir_inc_ms":       round1(biInc),
		"bidir_mbps":         round1(metrics.Mbps(biBytes, float64(biDur.Milliseconds()))),
		"bidir_grade":        gBi,
		"bidir_loss_pct":     round1(metrics.LossPercent(bi.failures, bi.attempts)),
		"bidir_jitter_ms":    round1(metrics.JitterMs(bi.samples)),
		"bidir_rpm":          round1(metrics.RPM(bi.rpmOK, bi.duration.Seconds())),
		"recovery_ms":        round1(recMs),
		"recovery_p50_ms":    round1(metrics.Percentile(recovery.samples, 50)),
		"overall_grade":      gAll,
	}

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(result)
		return
	}

	fmt.Printf("Overall: %s  (down %s / up %s / both %s)\n", gAll, gDown, gUp, gBi)
	fmt.Printf("Warm-up: %d streams · %.0f Mbps\n", bestStreams, bestMbps)
	fmt.Printf("Down: +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n",
		downInc, result["download_mbps"], result["download_loss_pct"], result["download_jitter_ms"], result["download_rpm"])
	fmt.Printf("Up:   +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n",
		upInc, result["upload_mbps"], result["upload_loss_pct"], result["upload_jitter_ms"], result["upload_rpm"])
	fmt.Printf("Both: +%.1f ms @ %.1f Mbps · loss %.1f%% · jitter %.1f · RPM %.0f\n",
		biInc, result["bidir_mbps"], result["bidir_loss_pct"], result["bidir_jitter_ms"], result["bidir_rpm"])
	if recMs != recMs { // NaN
		fmt.Printf("Recovery: did not return to idle+5ms within window\n")
	} else {
		fmt.Printf("Recovery: %.0f ms to near-idle (p50 %.1f ms)\n", recMs, result["recovery_p50_ms"])
	}
}

func round1(v float64) float64 {
	if v != v {
		return v
	}
	return float64(int(v*10+0.5)) / 10
}

func begin(c *http.Client, base, id string) error {
	body, _ := json.Marshal(map[string]string{"sessionId": id})
	res, err := c.Post(base+"/test/begin", "application/json", bytes.NewReader(body))
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
	res, err := c.Post(base+"/test/end", "application/json", bytes.NewReader(body))
	if err == nil {
		res.Body.Close()
	}
}

func ping(c *http.Client, base, sessionID string) (float64, error) {
	t0 := time.Now()
	req, err := http.NewRequest(http.MethodGet, base+"/ping", nil)
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
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("status %d", res.StatusCode)
	}
	return float64(time.Since(t0).Microseconds()) / 1000, nil
}

func sampleProbes(c *http.Client, base, sessionID string, d time.Duration) probeStats {
	var st probeStats
	t0 := time.Now()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		st.attempts++
		ms, err := ping(c, base, sessionID)
		if err == nil {
			st.samples = append(st.samples, ms)
			st.sampleTimes = append(st.sampleTimes, float64(time.Since(t0).Milliseconds()))
			st.successes++
		} else {
			st.failures++
		}
		time.Sleep(200 * time.Millisecond)
	}
	st.duration = time.Since(t0)
	return st
}

func runLoad(c *http.Client, base, sessionID string, streams, chunk int, d time.Duration, download, _ bool, rpmBudget float64) (int64, time.Duration, probeStats) {
	if download {
		return runLoadBi(c, base, sessionID, streams, 0, chunk, d, rpmBudget)
	}
	return runLoadBi(c, base, sessionID, 0, streams, chunk, d, rpmBudget)
}

func runLoadBi(c *http.Client, base, sessionID string, downStreams, upStreams, chunk int, d time.Duration, rpmBudget float64) (int64, time.Duration, probeStats) {
	var transferred atomic.Int64
	var st probeStats
	var mu sync.Mutex
	stop := make(chan struct{})
	var wg sync.WaitGroup

	payload := make([]byte, chunk)
	_, _ = rand.Read(payload)

	startWorkers := func(isDownload bool, n int) {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					if isDownload {
						req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/download?size=%d", base, len(payload)), nil)
						if err != nil {
							continue
						}
						req.Header.Set("X-Session-Id", sessionID)
						res, err := c.Do(req)
						if err != nil {
							continue
						}
						nRead, _ := io.Copy(io.Discard, res.Body)
						res.Body.Close()
						if res.StatusCode == http.StatusOK {
							transferred.Add(nRead)
						}
					} else {
						req, err := http.NewRequest(http.MethodPost, base+"/upload", bytes.NewReader(payload))
						if err != nil {
							continue
						}
						req.Header.Set("X-Session-Id", sessionID)
						req.Header.Set("Content-Type", "application/octet-stream")
						res, err := c.Do(req)
						if err != nil {
							continue
						}
						_, _ = io.Copy(io.Discard, res.Body)
						res.Body.Close()
						if res.StatusCode == http.StatusOK {
							transferred.Add(int64(len(payload)))
						}
					}
				}
			}()
		}
	}

	if downStreams > 0 {
		startWorkers(true, downStreams)
	}
	if upStreams > 0 {
		startWorkers(false, upStreams)
	}

	t0 := time.Now()
	deadline := time.Now().Add(d)
	if rpmBudget < 80 || rpmBudget != rpmBudget {
		rpmBudget = 80
	}
	for time.Now().Before(deadline) {
		st.attempts++
		ms, err := ping(c, base, sessionID)
		mu.Lock()
		if err == nil {
			st.samples = append(st.samples, ms)
			st.sampleTimes = append(st.sampleTimes, float64(time.Since(t0).Milliseconds()))
			st.successes++
			if ms <= rpmBudget {
				st.rpmOK++
			}
		} else {
			st.failures++
		}
		mu.Unlock()
		time.Sleep(200 * time.Millisecond)
	}
	close(stop)
	wg.Wait()
	st.duration = time.Since(t0)
	return transferred.Load(), st.duration, st
}
