package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/openwrt-builder/custom-bufferbloat/internal/handlers"
	"github.com/openwrt-builder/custom-bufferbloat/internal/lock"
	"github.com/openwrt-builder/custom-bufferbloat/web"
)

func main() {
	listen := flag.String("listen", envOr("LISTEN", ":8080"), "listen address")
	maxConcurrent := flag.Int("max-concurrent", envInt("MAX_CONCURRENT", 1), "max concurrent tests")
	streams := flag.Int("download-streams", envInt("DOWNLOAD_STREAMS", 4), "suggested parallel download streams for UI")
	upStreams := flag.Int("upload-streams", envInt("UPLOAD_STREAMS", 2), "suggested parallel upload streams for UI (keep low to reduce client CPU)")
	lockTTL := flag.Duration("lock-ttl", 60*time.Second, "test lock TTL")
	flag.Parse()

	l := lock.New(*maxConcurrent, *lockTTL)
	api := handlers.New(l, *streams, *upStreams, *maxConcurrent)

	mux := http.NewServeMux()
	api.Routes(mux)

	static := http.FileServer(http.FS(web.FS))
	mux.Handle("GET /{$}", static)
	mux.Handle("GET /index.html", static)
	mux.Handle("GET /app.js", static)
	mux.Handle("GET /style.css", static)
	mux.Handle("GET /ping-worker.js", static)

	// Generous timeouts: load phases stream multi‑MiB bodies on slow links.
	srv := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("bufferbloat-test listening on %s (max-concurrent=%d)", *listen, *maxConcurrent)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
