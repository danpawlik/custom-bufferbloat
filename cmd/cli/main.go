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

func main() {
	baseURL := flag.String("url", "http://127.0.0.1:8080", "server base URL")
	jsonOut := flag.Bool("json", false, "print JSON result")
	downStreams := flag.Int("streams", 4, "parallel download streams")
	upStreams := flag.Int("upload-streams", 2, "parallel upload streams (lower = less client CPU)")
	flag.Parse()

	client := &http.Client{Timeout: 120 * time.Second}
	sessionID := fmt.Sprintf("cli-%d", time.Now().UnixNano())

	if err := begin(client, *baseURL, sessionID); err != nil {
		fmt.Fprintf(os.Stderr, "begin: %v\n", err)
		os.Exit(1)
	}
	defer end(client, *baseURL, sessionID)

	idle := sampleLatency(client, *baseURL, sessionID, 5*time.Second)
	downBytes, downDur, downLat := runLoad(client, *baseURL, sessionID, *downStreams, 10*time.Second, true)
	upBytes, upDur, upLat := runLoad(client, *baseURL, sessionID, *upStreams, 10*time.Second, false)

	downInc := metrics.Increase(idle, downLat)
	upInc := metrics.Increase(idle, upLat)
	gDown := metrics.Grade(downInc)
	gUp := metrics.Grade(upInc)
	gAll := metrics.WorseGrade(gDown, gUp)

	result := map[string]any{
		"idle_p50_ms":       round1(metrics.Percentile(idle, 50)),
		"idle_p95_ms":       round1(metrics.Percentile(idle, 95)),
		"download_p50_ms":   round1(metrics.Percentile(downLat, 50)),
		"download_p95_ms":   round1(metrics.Percentile(downLat, 95)),
		"download_inc_ms":   round1(downInc),
		"download_mbps":     round1(metrics.Mbps(downBytes, float64(downDur.Milliseconds()))),
		"download_grade":    gDown,
		"upload_p50_ms":     round1(metrics.Percentile(upLat, 50)),
		"upload_p95_ms":     round1(metrics.Percentile(upLat, 95)),
		"upload_inc_ms":     round1(upInc),
		"upload_mbps":       round1(metrics.Mbps(upBytes, float64(upDur.Milliseconds()))),
		"upload_grade":      gUp,
		"overall_grade":     gAll,
	}

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(result)
		return
	}

	fmt.Printf("Overall: %s  (down %s / up %s)\n", gAll, gDown, gUp)
	fmt.Printf("Idle p50/p95: %.1f / %.1f ms\n", result["idle_p50_ms"], result["idle_p95_ms"])
	fmt.Printf("Down increase: %.1f ms @ %.1f Mbps\n", result["download_inc_ms"], result["download_mbps"])
	fmt.Printf("Up increase:   %.1f ms @ %.1f Mbps\n", result["upload_inc_ms"], result["upload_mbps"])
}

func round1(v float64) float64 {
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
	return float64(time.Since(t0).Microseconds()) / 1000, nil
}

func sampleLatency(c *http.Client, base, sessionID string, d time.Duration) []float64 {
	var out []float64
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		ms, err := ping(c, base, sessionID)
		if err == nil {
			out = append(out, ms)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return out
}

func runLoad(c *http.Client, base, sessionID string, streams int, d time.Duration, download bool) (int64, time.Duration, []float64) {
	var transferred atomic.Int64
	var lat []float64
	var mu sync.Mutex
	stop := make(chan struct{})
	var wg sync.WaitGroup

	payload := make([]byte, 2<<20)
	_, _ = rand.Read(payload)

	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if download {
					req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/download?size=%d", base, len(payload)), nil)
					if err != nil {
						continue
					}
					req.Header.Set("X-Session-Id", sessionID)
					res, err := c.Do(req)
					if err != nil {
						continue
					}
					n, _ := io.Copy(io.Discard, res.Body)
					res.Body.Close()
					if res.StatusCode == http.StatusOK {
						transferred.Add(n)
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
					var resp struct {
						Received int64 `json:"received"`
					}
					_ = json.NewDecoder(res.Body).Decode(&resp)
					res.Body.Close()
					if res.StatusCode == http.StatusOK {
						if resp.Received > 0 {
							transferred.Add(resp.Received)
						} else {
							transferred.Add(int64(len(payload)))
						}
					}
				}
			}
		}()
	}

	t0 := time.Now()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		ms, err := ping(c, base, sessionID)
		if err == nil {
			mu.Lock()
			lat = append(lat, ms)
			mu.Unlock()
		}
		time.Sleep(200 * time.Millisecond)
	}
	close(stop)
	wg.Wait()
	return transferred.Load(), time.Since(t0), lat
}
