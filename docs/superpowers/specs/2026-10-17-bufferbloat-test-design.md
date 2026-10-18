# Self-hosted Bufferbloat Test — Design Spec

**Date:** 2026-10-17
**Status:** Implemented (MVP + extended methodology)
**Location:** `custom-bufferbloat/`

## Summary

Self-hosted, LibreQoS-inspired **bufferbloat / responsiveness** test: one **Go** binary serves an embedded browser UI and HTTP endpoints for latency probes plus download/upload saturation. Same binary targets **VPS** and **OpenWrt**. No authentication in v1. CLI client talks to the same API.

## Goals

- Measure **latency under load** (bufferbloat), not just idle speed.
- Web UI in the spirit of Waveform / LibreQoS / Cloudflare Speed: live gauges, phase rail, charts, grades A+–F.
- Run on **OpenWrt** and **VPS** from one codebase.
- HTTP-only load and ping (no WebSockets).
- Extended diagnostics: warm-up, bidirectional load, probe loss, jitter, RPM (SLA), recovery.

## Non-goals (v1)

- Authentication / TLS inside the binary (reverse proxy / firewall if WAN).
- Quality of Outcome (QoO), Virtual Household, online rankings.
- Server-side persistent history / database (browser-local history is supported).
- Full browser E2E in CI (manual headless smoke checks and Node helper tests are available).
- C implementation.
- Raw ICMP packet-loss measurement (we report **HTTP probe** loss only).

## Chosen approach

**Approach A — single Go binary + HTTP-only.**

| Rejected | Why |
|----------|-----|
| WebSocket latency + HTTP load | Extra complexity; worse behind some proxies |
| Split load-server + API | Overkill for OpenWrt |

**Language:** Go (stdlib HTTP; `go:embed` UI).
**Auth:** none.
**Concurrency:** one active test (`/test/begin` lock); load endpoints require `X-Session-Id`.

## Architecture

```text
Browser ──► GET  /                 (embedded UI)
         ──► GET  /api/config
         ──► GET  /ping             (RTT; Web Worker)
         ──► GET  /download         (requires session)
         ──► POST /upload           (requires session)
         ──► POST /test/begin|end
         ──► GET  /health
              │
         Go binary (VPS or OpenWrt)
```

### Test flow (~45–65 s wall clock)

UI-driven phases (scored phases use warm-up-chosen streams/chunk):

1. **Baseline** — idle RTT only (**no** RPM bursts; keeps idle p50 clean).
2. **Warm-up** — raise download streams/chunk until throughput plateaus.
3. **Drain (~2 s)** — no load; avoid warm-up queue carry-over into grades.
4. **Download (scored)** — parallel GETs + latency + RPM bursts.
5. **Drain (~1 s)**
6. **Upload (scored)** — parallel POSTs + latency + RPM (fewer streams; cheaper CPU).
7. **Drain (~1 s)**
8. **Bidirectional (scored)** — down + up together; separate grade.
9. **Recovery** — no load; time until **3 consecutive** samples ≤ idle p50 + 5 ms.
10. **Analysis** — compute cards / overall grade.

**Overall grade** = worse of download / upload / bidirectional (LibreQoS-style increase: loaded p90 − idle p5, noise floor 2 ms).

### Where measurement applies

| Server location | What you mostly measure |
|-----------------|-------------------------|
| VPS | Path through ISP |
| OpenWrt + client on LAN | LAN / Wi‑Fi ↔ router |
| OpenWrt from WAN | External path to router (open port; no auth) |

## API

| Method | Path | Role |
|--------|------|------|
| `GET` | `/` | Static UI |
| `GET` | `/health` | Liveness |
| `GET` | `/api/config` | `downloadStreams`, `uploadStreams`, `maxConcurrent` |
| `GET` | `/ping` | Latency probe (optional `X-Session-Id` refreshes lock TTL) |
| `GET` | `/download?size=N` | Downlink saturation (**session required**) |
| `POST` | `/upload` | Uplink saturation (**session required**) |
| `POST` | `/test/begin` | Acquire lock → `409` if busy |
| `POST` | `/test/end` | Release lock |

Load without session → **403**.

### Locking / config

- `--max-concurrent` default `1`.
- `--lock-ttl` default **90s** (full run can approach a minute).
- `--download-streams` / `--upload-streams` (UI hints; warm-up may raise download streams).
- Env: `LISTEN`, `MAX_CONCURRENT`, `DOWNLOAD_STREAMS`, `UPLOAD_STREAMS`.

## Metrics definitions

| Metric | Definition |
|--------|------------|
| Increase | loaded p90 − idle p5; &lt; 2 ms → 0 |
| Grade | A+…F from increase (same thresholds as LibreQoS Bufferbloat-Test) |
| Probe loss | Failed HTTP `/ping` **transport** only (not ICMP; not slow replies) |
| Smoothed RTT jitter | 1/16 EWMA of absolute RTT differences; reset to zero per phase (not RTP interarrival jitter) |
| RPM (SLA) | Successful probes/min finishing within `max(80 ms, 3× idle p50)`; slow OK replies lower RPM only |
| Recovery | Elapsed ms until 3 consecutive samples ≤ idle p50 + 5 ms (timestamped) |

### Grade scale (latency increase)

| Increase | Grade |
|----------|-------|
| &lt; 5 ms | A+ |
| &lt; 30 ms | A |
| &lt; 60 ms | B |
| &lt; 200 ms | C |
| &lt; 400 ms | D |
| ≥ 400 ms | F |

## UI

- Pill **Start** button; phase rail (baseline → warm-up → down → up → both → recovery).
- Live gauges (latency / throughput), probe loss / jitter / RPM readouts.
- Canvas latency chart with phase colors.
- Results: overall medal + down/up/bidir grades with bloat meters + detail cards.
- Ping probes run in a **Web Worker** (`ping-worker.js`).
- Upload payload: cheap tiled Blob (no multi‑MiB `crypto.getRandomValues`).

## CLI

`cmd/cli` against `--url` with optional `--json`. Same phase ideas (warm-up, drains, bidir, recovery). RPM is sequential with the same SLA budget (not parallel bursts like the browser).

## Repository layout

```text
custom-bufferbloat/
  cmd/server/main.go
  cmd/cli/main.go
  internal/handlers/
  internal/lock/
  internal/metrics/
  web/                   # index.html, app.js, style.css, ping-worker.js
  openwrt/               # package Makefile + procd init
  scripts/build-openwrt-binary.sh
  Dockerfile
  README.md
  docs/screen-shoots/screen.png
  docs/superpowers/specs/2026-10-17-bufferbloat-test-design.md
```

## Packaging

- **VPS:** Docker or static binary.
- **OpenWrt:** cross-compile into `openwrt/files/usr/bin/` + procd init; or `scp` install path in README.

## Testing

- Go unit tests: handlers, lock, metrics (grades, jitter, loss, recovery stable).
- Manual: browser + CLI against local/VPS/router.
- No automated browser E2E in v1.

## Known limitations

- Probe loss ≠ packet loss.
- Warm-up windows are short; may under-saturate multi‑gig links.
- Browser ~6 connections/host limits parallel streams.
- Upload is client-CPU heavy — keep upload streams low.
- No auth — do not expose WAN bare.

## Risks (mitigations)

- Router CPU — session lock, stream caps, cheap upload payload.
- Misread LAN results — documented in README.
- Lock expiry mid-test — 90s TTL + Touch on ping with session header.

## Reliability and saved runs (2026-10-18)

- Both clients cancel phase requests and bound probe timeouts. CLI signals trigger independent,
  bounded session cleanup; the browser has a Stop button and best-effort page-exit cleanup.
- `/upload?phase=upload|bidir` counts bytes as the server receives them, even for incomplete
  bodies. `/test/stats?phase=upload|bidir` returns session-local `{bytes, active}` counters.
  Counters expire with the session. The clients read settled counts after each upload phase.
- A grade requires five successful baseline/phase samples, nonzero payload in each required
  direction, and no load/accounting errors. Hidden browser tabs invalidate grades. HTTP probe
  failures remain visible as quality warnings; these checks do not prove link saturation.
- Recovery retains failed probes as streak breaks. JSON uses `null` for missing measurements;
  the CLI handles output errors. Bidirectional download/upload Mbps are reported separately.
- The browser stores the newest 20 labeled runs locally and supports JSON/CSV export,
  before/after comparisons, and clearing history. It stores no history on the server.
- Regression checks: `go test -race ./...`, `go vet ./...`, `node --test web/*.test.js`.

## Repeat mode and separate calibration

- Repeat mode is opt-in (`-repeat` in the CLI): exactly three fresh sessions with a
  cancellable 10-second cooldown between them. Completed runs survive a later failure
  or cancellation. The server slot is released during cooldowns.
- Browser history groups runs by `series_id`; group summaries and JSON export include
  the available runs, completed/requested counts, and numeric median/min/max/spread/count.
  Summaries exclude runs with withheld overall grades and missing metric values. No
  letter grades are averaged. CLI repeat JSON uses the same summary statistics.
- Download and upload each get up to three two-second calibration steps. Upload uses
  independent streams/chunks starting at 4 MiB and doubling up to 16 MiB.
  Download chunks start at 8 MiB and double up to 32 MiB. Each upload measurement subtracts the
  initial server byte counter to exclude earlier phases in the same session.
- A final step gaining more than 5% is rising, dropping more than 20% is unstable;
  otherwise positive, error-free steps establish a plateau. Invalid calibration is
  unconfirmed. These are heuristics, not proof of WAN saturation.
- Optional expected usable download/upload Mbps flag scored throughput below 80% of
  the expectation. Non-plateau calibration or low expected-speed attainment produces advisory notes
  beside the corresponding expected-speed fields. Grades remain based on valid latency
  measurements, and these runs remain eligible for repeat summaries. Exports preserve
  separate `download_advisory` and `upload_advisory` strings; CLI output uses speed notes.
- Stream caps are five download, three upload, and five total bidirectional. Both
  clients choose upload chunks independently of download chunks.

### Smoothed RTT jitter

Browser and CLI apply `J += (|RTT[i] - RTT[i-1]| - J) / 16`, initialized to zero
per phase, to successful probes. This adopts RFC 3550's smoothing, not its RTP
interarrival measurement. Exports identify the estimator with `jitter_method: "rtt-ewma-1/16"`; legacy runs retain their original mean absolute differences.
The final estimator is reported, and grading is unaffected.
