# Bufferbloat Test

Self-hosted **LibreQoS-style** bufferbloat test: one **Go** binary for **VPS** and **OpenWrt**.

The browser (or CLI) talks to **this server** over HTTP: idle latency, then latency under download/upload load, with percentiles and grades **A+–F**.

## What the result means

| Where the server runs | What you mostly measure |
|-----------------------|-------------------------|
| VPS on the internet | Path through your ISP (classic bufferbloat) |
| OpenWrt on LAN | LAN / Wi‑Fi ↔ router (not necessarily ISP) |
| OpenWrt exposed on WAN | Path to the router from outside (open port; **no auth** in v1) |

## How to run

**Requires:** Go 1.22+ (for local build), or Docker.

### 1. Local (dev / laptop)

```bash
cd custom-bufferbloat

# option A — run without installing a binary
go run ./cmd/server -listen :8080

# option B — build then run
go build -o bufferbloat-test ./cmd/server
./bufferbloat-test -listen :8080
```

Then open in a browser:

- same machine: [http://127.0.0.1:8080](http://127.0.0.1:8080)
- another device on LAN: `http://<host-lan-ip>:8080`

Click **Start test**. The run takes ~30 seconds (baseline → download load → upload load → results).

Health check:

```bash
curl -s http://127.0.0.1:8080/health
# {"ok":true}
```

Stop the server with `Ctrl+C`.

### 2. Docker (VPS or local)

```bash
cd custom-bufferbloat
docker build -t bufferbloat-test .
docker run --rm -p 8080:8080 bufferbloat-test
```

Open `http://<host>:8080`. To change the listen address inside the container:

```bash
docker run --rm -p 8080:8080 -e LISTEN=:8080 bufferbloat-test
```

### 3. CLI client (against a running server)

Start the server first (step 1 or 2), then:

```bash
go run ./cmd/cli -url http://127.0.0.1:8080
go run ./cmd/cli -url http://127.0.0.1:8080 -json
# or after: go build -o bufferbloat-test-cli ./cmd/cli
./bufferbloat-test-cli -url http://192.168.1.1:8080 -json
```

The CLI talks to the same HTTP API as the browser (~25–30 s).

### 4. OpenWrt

1. Cross-compile a static binary for your board:

```bash
chmod +x scripts/build-openwrt-binary.sh
./scripts/build-openwrt-binary.sh arm64   # or armv7 / mipsle / amd64
# writes openwrt/files/usr/bin/bufferbloat-test
```

2. Copy the binary to the router (quick path without a full package build):

```bash
scp openwrt/files/usr/bin/bufferbloat-test root@192.168.1.1:/usr/bin/
scp openwrt/files/etc/init.d/bufferbloat-test root@192.168.1.1:/etc/init.d/
ssh root@192.168.1.1 'chmod +x /usr/bin/bufferbloat-test /etc/init.d/bufferbloat-test'
```

3. Start on the router:

```sh
# one-shot (foreground / test)
/usr/bin/bufferbloat-test -listen :8080 -max-concurrent 1

# or as a service
/etc/init.d/bufferbloat-test enable
/etc/init.d/bufferbloat-test start
/etc/init.d/bufferbloat-test status
```

4. From a LAN client open `http://<router-ip>:8080` and click **Start test**.

Default listen: `0.0.0.0:8080`, max one concurrent test. Optionally integrate `openwrt/` as an OpenWrt package/feed instead of `scp`.

**Note:** With the server on the router and the browser on LAN, you mostly measure **LAN/Wi‑Fi ↔ router**, not ISP bufferbloat. For ISP-path results, run the server on a **VPS**.

## HTTP API

| Method | Path | Role |
|--------|------|------|
| `GET` | `/` | Web UI |
| `GET` | `/health` | Liveness |
| `GET` | `/api/config` | UI hints (`downloadStreams`) |
| `GET` | `/ping` | Latency probe |
| `GET` | `/download?size=N` | Download saturation (requires `X-Session-Id`) |
| `POST` | `/upload` | Upload saturation (requires `X-Session-Id`) |
| `POST` | `/test/begin` | Acquire lock (`{"sessionId"}`) → `409` if busy |
| `POST` | `/test/end` | Release lock |

Load endpoints return **403** without an active session from `/test/begin`.

## Flags

```
-listen :8080
-max-concurrent 1
-download-streams 4
-lock-ttl 1m
```

Env overrides: `LISTEN`, `MAX_CONCURRENT`, `DOWNLOAD_STREAMS`.

## Security note

**No authentication** in v1. Do not expose to the public internet without a reverse proxy, firewall, or your own auth layer.

## Development

```bash
go test ./...
go build -trimpath -ldflags="-s -w" -o bufferbloat-test ./cmd/server
go build -trimpath -ldflags="-s -w" -o bufferbloat-test-cli ./cmd/cli
```

Stripped server binary is ~6 MiB (OK on modern OpenWrt boards; tight on tiny flash).

### Methodology notes

- Latency samples use a **Web Worker** so main-thread download/upload work does not fake bufferbloat.
- Grades use LibreQoS-style **loaded p90 − idle p5** (noise floor 2 ms); overall = worse of down/up.
- Browser connection limits (~6 per host) → default **4** parallel load streams leaves room for pings.
- Load endpoints require an active `/test/begin` session (`X-Session-Id`).

Design spec: [docs/superpowers/specs/2026-10-17-bufferbloat-test-design.md](docs/superpowers/specs/2026-10-17-bufferbloat-test-design.md)
