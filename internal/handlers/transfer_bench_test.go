package handlers

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// BenchmarkTransfer measures complete HTTP requests over loopback, not a router's link capacity.
func BenchmarkTransfer(b *testing.B) {
	for _, download := range []bool{true, false} {
		sizes := []int{256 << 10, 4 << 20, 16 << 20}
		direction := "upload"
		if download {
			sizes = []int{2 << 20, 8 << 20, 32 << 20}
			direction = "download"
		}
		for _, size := range sizes {
			b.Run(fmt.Sprintf("%s/%dKiB", direction, size>>10), func(b *testing.B) {
				s := testServer()
				if !s.Lock.TryAcquire("bench") {
					b.Fatal("acquire")
				}
				mux := http.NewServeMux()
				s.Routes(mux)
				server := httptest.NewServer(mux)
				defer server.Close()
				client := server.Client()
				payload := bytes.Repeat([]byte{0x5a}, size)
				b.SetBytes(int64(size))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					method, url := http.MethodPost, server.URL+"/upload"
					var body io.Reader = bytes.NewReader(payload)
					if download {
						method, url, body = http.MethodGet, fmt.Sprintf("%s/download?size=%d", server.URL, size), nil
					}
					req, err := http.NewRequest(method, url, body)
					if err != nil {
						b.Fatal(err)
					}
					req.Header.Set("X-Session-Id", "bench")
					res, err := client.Do(req)
					if err != nil {
						b.Fatal(err)
					}
					n, err := io.Copy(io.Discard, res.Body)
					res.Body.Close()
					if err != nil || res.StatusCode != http.StatusOK || (download && n != int64(size)) {
						b.Fatalf("transfer: bytes=%d status=%d err=%v", n, res.StatusCode, err)
					}
				}
			})
		}
	}
}
