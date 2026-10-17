# Self-hosted Bufferbloat Test — Design Spec

**Date:** 2026-10-17  
**Status:** Approved for implementation planning  
**Location:** `custom-bufferbloat/`

## Summary

Build a **self-hosted, LibreQoS-inspired bufferbloat test**: a single **Go** binary that serves a browser UI and HTTP endpoints for latency probes plus download/upload saturation. The same binary targets **VPS** and **OpenWrt**. No authentication in v1. A thin CLI that reuses the same endpoints is a non-blocking bonus.

## Goals

- Measure **latency under load** (bufferbloat), not just idle speed.
- Provide a **web UI** similar in spirit to [Waveform Bufferbloat](https://www.waveform.com/tools/bufferbloat) / [LibreQoS test](https://test.libreqos.com/): start button, live charts, percentiles, separate up/down grades.
- Run on **OpenWrt routers** and **VPS** from one codebase.
- Keep the server small: **HTTP-only** load and ping (no WebSockets in v1).

## Non-goals (v1)

- Authentication / TLS inside the binary (use reverse proxy or firewall if exposing WAN).
- Quality of Outcome (QoO), Virtual Household, online rankings.
- Persistent history / database.
- Full browser E2E test suite.
- C implementation.

## Chosen approach

**Approach A — single Go binary + HTTP-only** (inspired by [LibreQoE/Bufferbloat-Test](https://github.com/LibreQoE/Bufferbloat-Test)):

| Rejected | Why |
|----------|-----|
| WebSocket latency + HTTP load | Extra complexity; worse behind some proxies; LibreQoS deliberately stayed HTTP-only |
| Split load-server + API processes | Overkill for OpenWrt; harder to package |

**Language:** Go (stdlib HTTP; embed static UI).  
**Auth:** none (open URL).  
**Concurrency:** one active test at a time (critical on routers).

## Architecture

```text
Browser ──► GET  /              (embedded UI)
         ──► GET  /ping          (RTT measured in browser / Web Worker)
         ──► GET  /download      (saturate downlink)
         ──► POST /upload        (saturate uplink)
         ──► POST /test/begin|end (optional session lock)
         ──► GET  /health
              │
         Go binary (VPS or OpenWrt)
```

### Test flow (~30 seconds)

1. **Baseline (~0–5 s)** — latency samples only.  
2. **Download saturation (~5–15 s)** — parallel HTTP GETs + continuous latency.  
3. **Upload saturation (~15–25 s)** — parallel HTTP POSTs + continuous latency.  
4. **Cooldown / analysis (~25–30 s)** — stop load, compute percentiles, grades, throughput.

Timing windows are configurable defaults; UI drives the phases.

### Where measurement applies

- **Server on VPS, client at home** → path through ISP (classic bufferbloat).  
- **Server on OpenWrt, client on LAN** → mainly LAN/Wi‑Fi ↔ router path.  
- **Server on OpenWrt, client from WAN** → possible but operator must open the port; no auth in v1.

Document this clearly in the README so results are not misinterpreted.

## API

| Method | Path | Role |
|--------|------|------|
| `GET` | `/` | Static UI (`go:embed`) |
| `GET` | `/health` | Liveness (`{"ok":true}`) |
| `GET` | `/ping` | Tiny response; client timestamps RTT (optional server `Date` / custom header) |
| `GET` | `/download?size=N` | Stream `N` bytes (or chunked until client aborts) |
| `POST` | `/upload` | Discard body; return bytes received |
| `POST` | `/test/begin` | Acquire test lock; `409` if busy |
| `POST` | `/test/end` | Release lock |

### Locking

- Default `--max-concurrent 1`.  
- Lock auto-expires after ~60 s if client dies.  
- Concurrent begin while locked → HTTP **409** and UI message.

### Configuration (flags / env)

- `--listen` (default `:8080`)  
- `--max-concurrent` (default `1`)  
- Optional UI hints: suggested parallel stream count for fast links  

## UI and metrics

### UI

- Large **Start** control.  
- Live phase label, throughput, latency time series (Chart.js or lightweight canvas).  
- Phase-colored chart (baseline / download / upload).  
- Results cards: idle latency, loaded down/up, increase, throughput down/up, grades.

### Percentiles

- Report at least **p50** and **p95** per phase.  
- Bufferbloat increase (LibreQoS-style): **loaded p90 − idle p5**, treating differences **&lt; 2 ms** as noise.  
- Grade **download and upload separately**; **overall = worse of the two**.

### Grade scale (latency increase)

| Increase | Grade |
|----------|-------|
| &lt; 5 ms | A+ |
| &lt; 30 ms | A |
| &lt; 60 ms | B |
| &lt; 200 ms | C |
| &lt; 400 ms | D |
| ≥ 400 ms | F |

### CLI (bonus, non-blocking)

- `bufferbloat-test --json` against local or `--url http://host:8080`.  
- Same metrics as web; may ship after web MVP.

## Repository layout

```text
custom-bufferbloat/
  cmd/server/main.go
  internal/handlers/     # ping, download, upload, health, begin/end
  internal/lock/         # single-flight test lock + TTL
  web/                   # HTML/CSS/JS (embedded)
  openwrt/               # OpenWrt package Makefile + procd init
  Dockerfile
  README.md
  docs/superpowers/specs/2026-10-17-bufferbloat-test-design.md
```

## Packaging and deploy

### VPS

- Multi-arch binary (`linux/amd64`, `linux/arm64`) and/or `Dockerfile`.  
- Listen on `:8080` (or behind Caddy/nginx for TLS later).

### OpenWrt

- Cross-compile (`GOOS=linux`, board `GOARCH` / `GOMIPS` as needed).  
- Package under `openwrt/` with **procd** init, default listen `0.0.0.0:8080`.  
- Keep binary size and CPU use in mind: one test lock, avoid unbounded streams.

## Error handling

- **409** — test already running.  
- Network / ping failures — end with partial results + warning in UI.  
- Cap upload size and download duration so handlers cannot hang forever.  
- `/health` for operators.

## Testing strategy

- **Go unit tests:** handlers (ping body, download length, upload sink), lock 409 / TTL release.  
- **Manual:** local binary in browser → VPS → OpenWrt device.  
- No automated browser E2E in v1.

## Implementation order (high level)

1. Go server: `/health`, `/ping`, `/download`, `/upload`, lock begin/end.  
2. Embed minimal UI: run phases, collect samples, compute grades.  
3. LibreQoS-like charts and result cards.  
4. Dockerfile + README (VPS path).  
5. OpenWrt package + init.  
6. Optional CLI.

## Open decisions resolved

| Topic | Decision |
|-------|----------|
| Product shape | Self-hosted web app (not LuCI-first); CLI later |
| Deploy targets | Both VPS and OpenWrt, one codebase |
| Language | Go |
| MVP richness | LibreQoS-like UI (percentiles, up/down charts, grades) |
| Auth | None in v1 |
| Transport | HTTP-only |

## Risks

- **Router CPU / RAM** under multi-stream load — mitigate with stream caps and single-test lock.  
- **Misread results** when server is on LAN router — document measurement path.  
- **Open WAN + no auth** — document as operator responsibility; auth deferred.  
- **Gigabit saturation from browser** — may need several parallel streams; tune defaults after real runs.
