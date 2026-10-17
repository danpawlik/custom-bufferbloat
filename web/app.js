(() => {
  const PHASE = {
    baseline: { name: "Baseline", color: "#5b9dff", durationMs: 4000 },
    warmup: { name: "Warm-up", color: "#94a3b8", durationMs: 6000 },
    download: { name: "Download", color: "#2ee6c5", durationMs: 8000 },
    upload: { name: "Upload", color: "#ffb020", durationMs: 8000 },
    bidir: { name: "Bidirectional", color: "#c084fc", durationMs: 8000 },
    recovery: { name: "Recovery", color: "#8b9bb0", durationMs: 4000 },
    drain: { name: "Drain", color: "#64748b", durationMs: 2000 },
    cooldown: { name: "Analysis", color: "#8b9bb0", durationMs: 1500 },
  };

  const PHASE_ORDER = ["baseline", "warmup", "download", "upload", "bidir", "recovery"];
  const PING_EVERY_MS = 200;
  const RPM_PARALLEL = 3;

  const el = {
    start: document.getElementById("startBtn"),
    startLabel: document.querySelector(".start-label"),
    status: document.getElementById("status"),
    live: document.getElementById("livePanel"),
    phase: document.getElementById("phase"),
    phaseHint: document.getElementById("phaseHint"),
    phaseBar: document.getElementById("phaseBar"),
    phaseRail: document.getElementById("phaseRail"),
    heroStage: document.getElementById("heroStage"),
    liveLatency: document.getElementById("liveLatency"),
    liveThroughput: document.getElementById("liveThroughput"),
    liveLoss: document.getElementById("liveLoss"),
    liveJitter: document.getElementById("liveJitter"),
    liveRpm: document.getElementById("liveRpm"),
    results: document.getElementById("results"),
    cards: document.getElementById("resultCards"),
    warning: document.getElementById("warning"),
    gradeOverall: document.querySelector("#gradeOverall .grade"),
    gradeOverallCard: document.getElementById("gradeOverall"),
    gradeCaption: document.getElementById("gradeCaption"),
    gradeDown: document.querySelector("#gradeDown .grade"),
    gradeUp: document.querySelector("#gradeUp .grade"),
    gradeBi: document.querySelector("#gradeBi .grade"),
    bloatDown: document.getElementById("bloatDown"),
    bloatUp: document.getElementById("bloatUp"),
    bloatBi: document.getElementById("bloatBi"),
    bloatDownLabel: document.getElementById("bloatDownLabel"),
    bloatUpLabel: document.getElementById("bloatUpLabel"),
    bloatBiLabel: document.getElementById("bloatBiLabel"),
    latencyGauge: document.getElementById("latencyGauge"),
    speedGauge: document.getElementById("speedGauge"),
  };

  let gaugeLatency = 0;
  let gaugeSpeed = 0;
  let chartPoints = [];
  let downloadStreams = 4;
  let uploadStreams = 2;
  let chunkBytes = 2 * 1024 * 1024;
  let abortControllers = [];
  let sessionId = null;
  let uploadBlob = null;
  let pingWorker = null;
  let pingSeq = 0;
  const pingWaiters = new Map();
  let totalPingFailures = 0;

  function ensurePingWorker() {
    if (pingWorker) return pingWorker;
    try {
      pingWorker = new Worker("/ping-worker.js");
      pingWorker.onmessage = (ev) => {
        const { id, ok, ms } = ev.data || {};
        const waiter = pingWaiters.get(id);
        if (!waiter) return;
        pingWaiters.delete(id);
        if (ok) waiter.resolve(ms);
        else waiter.reject(new Error("ping failed"));
      };
      pingWorker.onerror = () => {
        pingWorker = null;
      };
    } catch (_) {
      pingWorker = null;
    }
    return pingWorker;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  function gradeForIncrease(ms) {
    if (!(ms >= 0) || Number.isNaN(ms)) return "—";
    if (ms < 5) return "A+";
    if (ms < 30) return "A";
    if (ms < 60) return "B";
    if (ms < 200) return "C";
    if (ms < 400) return "D";
    return "F";
  }

  const GRADE_RANK = { "A+": 0, A: 1, B: 2, C: 3, D: 4, F: 5, "—": 6 };

  function worseGrade(a, b) {
    return (GRADE_RANK[a] ?? 6) >= (GRADE_RANK[b] ?? 6) ? a : b;
  }

  function worseGrades(...gs) {
    if (!gs.length) return "—";
    let w = gs[0];
    for (let i = 1; i < gs.length; i++) w = worseGrade(w, gs[i]);
    return w;
  }

  function increaseMs(idleSamples, loadedSamples) {
    const idle = [...idleSamples].sort((a, b) => a - b);
    const loaded = [...loadedSamples].sort((a, b) => a - b);
    const delta = percentile(loaded, 90) - percentile(idle, 5);
    if (Number.isNaN(delta)) return NaN;
    return delta < 2 ? 0 : delta;
  }

  function jitterMs(samples) {
    if (samples.length < 2) return NaN;
    let sum = 0;
    for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
    return sum / (samples.length - 1);
  }

  function lossPercent(failed, total) {
    if (!total) return NaN;
    return (failed / total) * 100;
  }

  function rpmFrom(successes, durationMs) {
    if (durationMs <= 0) return NaN;
    return (successes / (durationMs / 1000)) * 60;
  }

  function fmtMs(v) {
    if (Number.isNaN(v)) return "—";
    return v.toFixed(1) + " ms";
  }

  function fmtPct(v) {
    if (Number.isNaN(v)) return "—";
    return v.toFixed(1) + "%";
  }

  function fmtRpm(v) {
    if (Number.isNaN(v)) return "—";
    return Math.round(v).toString();
  }

  function fmtMbps(bytes, ms) {
    if (!ms || ms <= 0) return "—";
    return ((bytes * 8) / (ms / 1000) / 1e6).toFixed(1) + " Mbps";
  }

  function parseMbps(text) {
    const m = /([\d.]+)\s*Mbps/.exec(text || "");
    return m ? parseFloat(m[1]) : NaN;
  }

  async function loadConfig() {
    try {
      const r = await fetch("/api/config");
      if (r.ok) {
        const j = await r.json();
        if (j.downloadStreams) downloadStreams = j.downloadStreams;
        if (j.uploadStreams) uploadStreams = j.uploadStreams;
        else uploadStreams = Math.max(1, Math.min(2, downloadStreams));
      }
    } catch (_) {}
  }

  function sessionHeaders() {
    const h = {};
    if (sessionId) h["X-Session-Id"] = sessionId;
    return h;
  }

  async function pingOnceMain() {
    const t0 = performance.now();
    const r = await fetch("/ping?t=" + t0, { cache: "no-store", headers: sessionHeaders() });
    if (!r.ok) throw new Error("ping failed");
    await r.arrayBuffer();
    return performance.now() - t0;
  }

  function pingOnce() {
    const worker = ensurePingWorker();
    if (!worker) return pingOnceMain();
    const id = ++pingSeq;
    return new Promise((resolve, reject) => {
      pingWaiters.set(id, { resolve, reject });
      worker.postMessage({
        id,
        url: "/ping?t=" + performance.now(),
        sessionId: sessionId,
      });
      setTimeout(() => {
        if (pingWaiters.has(id)) {
          pingWaiters.delete(id);
          reject(new Error("ping timeout"));
        }
      }, 5000);
    });
  }

  /** Parallel small probes for RPM-style responsiveness under load. */
  async function rpmBurst(n, budgetMs) {
    const jobs = [];
    for (let i = 0; i < n; i++) {
      jobs.push(
        (async () => {
          try {
            const ms = await pingOnce();
            return { transportOk: true, ms };
          } catch (_) {
            return { transportOk: false, ms: NaN };
          }
        })()
      );
    }
    const results = await Promise.all(jobs);
    let slaOk = 0;
    let transportFail = 0;
    for (const r of results) {
      if (!r.transportOk) transportFail += 1;
      else if (r.ms <= budgetMs) slaOk += 1;
      // slow-but-successful probes are RPM misses, not probe loss
    }
    return { slaOk, transportFail, total: n };
  }

  function drawArcGauge(canvas, value, max, color, unit) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = 220;
    const cssH = 130;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const cx = cssW / 2;
    const cy = cssH - 18;
    const r = 78;
    const start = Math.PI;
    const t = Math.max(0, Math.min(1, value / max));
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a2733";
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, 2 * Math.PI);
    ctx.stroke();
    const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "#ffffff88");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + Math.PI * t);
    ctx.stroke();
    const ang = start + Math.PI * t;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#7d8fa3";
    ctx.font = "600 10px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(unit, cx, cy - 8);
  }

  function updateGauges(latencyMs, mbps) {
    if (typeof latencyMs === "number" && !Number.isNaN(latencyMs)) gaugeLatency = latencyMs;
    if (typeof mbps === "number" && !Number.isNaN(mbps)) gaugeSpeed = mbps;
    drawArcGauge(el.latencyGauge, gaugeLatency, 200, "#5b9dff", "ms scale");
    drawArcGauge(el.speedGauge, gaugeSpeed, Math.max(100, gaugeSpeed * 1.2), "#2ee6c5", "Mbps scale");
  }

  function setPhaseUI(key, meta) {
    const idx = PHASE_ORDER.indexOf(key);
    const progress = idx >= 0 ? ((idx + 0.55) / PHASE_ORDER.length) * 100 : 100;
    if (el.phaseBar) el.phaseBar.style.width = progress + "%";
    if (el.phaseRail) {
      el.phaseRail.querySelectorAll(".phase-step").forEach((node) => {
        const p = node.getAttribute("data-phase");
        node.classList.remove("active", "done");
        const pi = PHASE_ORDER.indexOf(p);
        if (pi === idx) node.classList.add("active");
        else if (pi < idx) node.classList.add("done");
      });
    }
    if (meta) {
      el.phase.textContent = meta.name;
      const hints = {
        baseline: "Idle RTT",
        warmup: "Finding saturation point",
        download: "Scored downlink load",
        upload: "Scored uplink load",
        bidir: "Down + up together",
        recovery: "Queues draining",
        cooldown: "Computing grades",
      };
      if (el.phaseHint) el.phaseHint.textContent = hints[key] || "";
    }
  }

  function drawChart() {
    const canvas = document.getElementById("latencyChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = 170;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.strokeStyle = "#1a2733";
    for (let i = 1; i < 4; i++) {
      const y = (cssH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }
    if (chartPoints.length < 2) return;
    let maxY = 1;
    let maxX = 1;
    for (const p of chartPoints) {
      if (p.y > maxY) maxY = p.y;
      if (p.x > maxX) maxX = p.x;
    }
    maxY *= 1.15;
    const padL = 8,
      padR = 8,
      padT = 12,
      padB = 22;
    const mapX = (x) => padL + (x / maxX) * (cssW - padL - padR);
    const mapY = (y) => padT + (1 - y / maxY) * (cssH - padT - padB);
    for (let i = 1; i < chartPoints.length; i++) {
      const a = chartPoints[i - 1];
      const b = chartPoints[i];
      const color = b.color || a.color || "#2ee6c5";
      ctx.beginPath();
      ctx.moveTo(mapX(a.x), mapY(a.y));
      ctx.lineTo(mapX(b.x), mapY(b.y));
      ctx.lineTo(mapX(b.x), cssH - padB);
      ctx.lineTo(mapX(a.x), cssH - padB);
      ctx.closePath();
      ctx.fillStyle = color + "22";
      ctx.fill();
    }
    ctx.lineWidth = 2.25;
    for (let i = 1; i < chartPoints.length; i++) {
      const a = chartPoints[i - 1];
      const b = chartPoints[i];
      ctx.beginPath();
      ctx.strokeStyle = b.color || a.color || "#2ee6c5";
      ctx.moveTo(mapX(a.x), mapY(a.y));
      ctx.lineTo(mapX(b.x), mapY(b.y));
      ctx.stroke();
    }
    const last = chartPoints[chartPoints.length - 1];
    ctx.beginPath();
    ctx.fillStyle = last.color || "#2ee6c5";
    ctx.shadowColor = last.color || "#2ee6c5";
    ctx.shadowBlur = 10;
    ctx.arc(mapX(last.x), mapY(last.y), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function addChartPoint(tSec, ms, color) {
    chartPoints.push({ x: tSec, y: ms, color });
    drawChart();
  }

  function resetChart() {
    chartPoints = [];
    gaugeLatency = 0;
    gaugeSpeed = 0;
    updateGauges(0, 0);
    drawChart();
  }

  function gradeClass(g) {
    if (g === "A+") return "grade-A-plus";
    if (g === "A") return "grade-A";
    if (g === "B") return "grade-B";
    if (g === "C") return "grade-C";
    if (g === "D") return "grade-D";
    if (g === "F") return "grade-F";
    return "";
  }

  function gradeCaption(g) {
    const map = {
      "A+": "Excellent — queues stay tiny under load",
      A: "Great — mild delay under load",
      B: "OK — noticeable but usable",
      C: "Fair — calls/games will stutter",
      D: "Poor — heavy bloat under load",
      F: "Bad — latency collapses when busy",
    };
    return map[g] || "Incomplete sample";
  }

  function bloatWidth(incMs) {
    if (!(incMs >= 0) || Number.isNaN(incMs)) return 0;
    return Math.min(100, (incMs / 400) * 100);
  }

  async function beginTest(id) {
    const r = await fetch("/test/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    if (r.status === 409) {
      const err = new Error("busy");
      err.code = 409;
      throw err;
    }
    if (!r.ok) throw new Error("begin failed");
  }

  async function endTest(id) {
    try {
      await fetch("/test/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
    } catch (_) {}
  }

  function stopLoads() {
    for (const c of abortControllers) {
      try {
        c.abort();
      } catch (_) {}
    }
    abortControllers = [];
  }

  function startDownloadLoad(bytesRef, streams, size) {
    const controllers = [];
    const n = Math.max(1, streams);
    const sz = size || chunkBytes;
    for (let i = 0; i < n; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      abortControllers.push(ac);
      (async () => {
        while (!ac.signal.aborted) {
          try {
            const r = await fetch("/download?size=" + sz + "&n=" + Math.random(), {
              cache: "no-store",
              signal: ac.signal,
              headers: sessionHeaders(),
            });
            if (!r.ok || !r.body) {
              await new Promise((res) => setTimeout(res, 100));
              continue;
            }
            const reader = r.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytesRef.value += value.byteLength;
            }
          } catch (_) {
            if (ac.signal.aborted) return;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })();
    }
    return () => controllers.forEach((c) => c.abort());
  }

  function getUploadBlob(size) {
    if (uploadBlob && uploadBlob.size === size) return uploadBlob;
    const tileSize = 65536;
    const tile = new Uint8Array(tileSize);
    let x = 0xa5a5a5a5;
    for (let i = 0; i < tileSize; i++) {
      x = (Math.imul(1664525, x) + 1013904223) >>> 0;
      tile[i] = x >>> 24;
    }
    const parts = [];
    let rem = size;
    while (rem >= tileSize) {
      parts.push(tile);
      rem -= tileSize;
    }
    if (rem > 0) parts.push(tile.subarray(0, rem));
    uploadBlob = new Blob(parts, { type: "application/octet-stream" });
    return uploadBlob;
  }

  function startUploadLoad(bytesRef, streams, size) {
    const controllers = [];
    const blob = getUploadBlob(size || chunkBytes);
    const n = Math.max(1, streams);
    for (let i = 0; i < n; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      abortControllers.push(ac);
      (async () => {
        while (!ac.signal.aborted) {
          try {
            const r = await fetch("/upload", {
              method: "POST",
              body: blob,
              signal: ac.signal,
              headers: sessionHeaders(),
            });
            if (r.ok) {
              bytesRef.value += blob.size;
              if (r.body) {
                try {
                  await r.body.cancel();
                } catch (_) {}
              }
            }
          } catch (_) {
            if (ac.signal.aborted) return;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })();
    }
    return () => controllers.forEach((c) => c.abort());
  }

  function emptyStats() {
    return { samples: [], sampleTimes: [], attempts: 0, failures: 0, rpmSuccess: 0, rpmAttempts: 0, durationMs: 0 };
  }

  function updateLiveExtras(stats) {
    const loss = lossPercent(stats.failures, stats.attempts);
    const jit = jitterMs(stats.samples);
    const rpmDur = Math.max(stats.durationMs, 500);
    const rpm = rpmFrom(stats.rpmSuccess, rpmDur);
    if (el.liveLoss) el.liveLoss.textContent = fmtPct(loss);
    if (el.liveJitter) el.liveJitter.textContent = fmtMs(jit);
    if (el.liveRpm) el.liveRpm.textContent = fmtRpm(rpm);
  }

  function recoveryStableMs(stats, baselineP50, slackMs, need) {
    if (!stats.samples.length || Number.isNaN(baselineP50)) return NaN;
    const thr = baselineP50 + slackMs;
    let streak = 0;
    for (let i = 0; i < stats.samples.length; i++) {
      if (stats.samples[i] <= thr) {
        streak++;
        if (streak >= need) return stats.sampleTimes[i];
      } else {
        streak = 0;
      }
    }
    return NaN;
  }

  /**
   * Sample latency (+ optional RPM bursts) while optional load runs.
   * Returns stats object.
   */
  async function runPhase(key, meta, t0, opts) {
    opts = opts || {};
    // Drains keep the rail on the previous scored phase (avoid jumping backward).
    if (!opts.holdPhaseRail) setPhaseUI(key, meta);
    else {
      el.status.textContent = meta.name + "…";
      if (el.phaseHint) el.phaseHint.textContent = "Letting queues empty";
      if (el.phase) el.phase.textContent = meta.name;
    }
    if (!opts.holdPhaseRail) el.status.textContent = meta.name + "…";
    const stats = emptyStats();
    const bytesRef = opts.bytesRef || null;
    const idleP50 = opts.idleP50 || 20;
    const rpmBudget = Math.max(80, idleP50 * 3);

    let stopLoad = null;
    if (opts.loadFn) stopLoad = opts.loadFn();

    const phaseStart = performance.now();
    const endAt = phaseStart + (opts.durationMs || meta.durationMs);
    while (performance.now() < endAt) {
      stats.attempts += 1;
      try {
        const ms = await pingOnce();
        stats.samples.push(ms);
        stats.sampleTimes.push(performance.now() - phaseStart);
        el.liveLatency.textContent = fmtMs(ms);
        addChartPoint((performance.now() - t0) / 1000, ms, meta.color);

        // RPM: SLA successes ≠ probe loss (slow replies are RPM misses only).
        if (opts.rpm) {
          stats.attempts += RPM_PARALLEL;
          stats.rpmAttempts += RPM_PARALLEL;
          const burst = await rpmBurst(RPM_PARALLEL, rpmBudget);
          stats.rpmSuccess += burst.slaOk;
          stats.failures += burst.transportFail;
          totalPingFailures += burst.transportFail;
        }
      } catch (_) {
        stats.failures += 1;
        totalPingFailures += 1;
      }

      let mbps = NaN;
      if (bytesRef) {
        const elapsed = performance.now() - (bytesRef.tStart || phaseStart);
        const text = fmtMbps(bytesRef.value, elapsed);
        el.liveThroughput.textContent = text;
        mbps = parseMbps(text);
      } else {
        el.liveThroughput.textContent = "—";
      }
      stats.durationMs = performance.now() - phaseStart;
      updateLiveExtras(stats);
      updateGauges(stats.samples[stats.samples.length - 1] || 0, mbps);
      await new Promise((r) => setTimeout(r, PING_EVERY_MS));
    }

    if (stopLoad) stopLoad();
    stopLoads();
    stats.durationMs = performance.now() - phaseStart;
    return stats;
  }

  /** Adaptive warm-up: raise download streams until throughput plateaus. */
  async function runWarmup(t0, idleP50) {
    setPhaseUI("warmup", PHASE.warmup);
    el.status.textContent = "Warm-up…";
    let streams = Math.max(2, Math.min(downloadStreams, 4));
    let size = 1 * 1024 * 1024;
    let bestMbps = 0;
    let bestStreams = streams;
    let bestSize = size;
    const steps = 3;
    const stepMs = PHASE.warmup.durationMs / steps;
    const samples = [];

    for (let step = 0; step < steps; step++) {
      const bytesRef = { value: 0, tStart: performance.now() };
      const stats = await runPhase("warmup", PHASE.warmup, t0, {
        durationMs: stepMs,
        idleP50,
        bytesRef,
        loadFn: () => startDownloadLoad(bytesRef, streams, size),
      });
      for (const s of stats.samples) samples.push(s);
      const mbps = parseMbps(fmtMbps(bytesRef.value, stats.durationMs));
      el.status.textContent =
        "Warm-up… " + streams + " streams · " + (Number.isNaN(mbps) ? "—" : mbps.toFixed(0) + " Mbps");
      if (!Number.isNaN(mbps) && mbps > bestMbps * 1.05) {
        bestMbps = mbps;
        bestStreams = streams;
        bestSize = size;
        streams = Math.min(6, streams + 1);
        size = Math.min(4 * 1024 * 1024, size + 512 * 1024);
      } else {
        break;
      }
    }

    downloadStreams = bestStreams;
    chunkBytes = bestSize;
    uploadStreams = Math.max(1, Math.min(uploadStreams, Math.ceil(bestStreams / 2)));
    uploadBlob = null;
    return {
      samples,
      streams: bestStreams,
      chunk: bestSize,
      mbps: bestMbps,
      uploadStreams,
    };
  }

  function renderResults(ctx) {
    const {
      idle,
      down,
      up,
      bi,
      recovery,
      downBytes,
      downMs,
      upBytes,
      upMs,
      biBytes,
      biMs,
      warmup,
    } = ctx;

    const idleSorted = [...idle.samples].sort((a, b) => a - b);
    const idleP50 = percentile(idleSorted, 50);

    const downInc = increaseMs(idle.samples, down.samples);
    const upInc = increaseMs(idle.samples, up.samples);
    const biInc = increaseMs(idle.samples, bi.samples);
    const gDown = gradeForIncrease(downInc);
    const gUp = gradeForIncrease(upInc);
    const gBi = gradeForIncrease(biInc);
    const gAll = worseGrades(gDown, gUp, gBi);

    el.gradeOverall.textContent = gAll;
    el.gradeDown.textContent = gDown;
    el.gradeUp.textContent = gUp;
    if (el.gradeBi) el.gradeBi.textContent = gBi;
    if (el.gradeCaption) el.gradeCaption.textContent = gradeCaption(gAll);
    if (el.gradeOverallCard) el.gradeOverallCard.className = "medal " + gradeClass(gAll);

    if (el.bloatDown) el.bloatDown.style.width = bloatWidth(downInc) + "%";
    if (el.bloatUp) el.bloatUp.style.width = bloatWidth(upInc) + "%";
    if (el.bloatBi) el.bloatBi.style.width = bloatWidth(biInc) + "%";
    if (el.bloatDownLabel) el.bloatDownLabel.textContent = "bloat +" + fmtMs(downInc);
    if (el.bloatUpLabel) el.bloatUpLabel.textContent = "bloat +" + fmtMs(upInc);
    if (el.bloatBiLabel) el.bloatBiLabel.textContent = "bloat +" + fmtMs(biInc);

    const recUntil = recoveryStableMs(recovery, idleP50, 5, 3);
    const loadedLoss = lossPercent(
      down.failures + up.failures + bi.failures,
      down.attempts + up.attempts + bi.attempts
    );
    const loadedRpm = rpmFrom(
      down.rpmSuccess + up.rpmSuccess + bi.rpmSuccess,
      down.durationMs + up.durationMs + bi.durationMs
    );

    const rows = [
      ["Idle p50 / p95", fmtMs(idleP50) + " / " + fmtMs(percentile(idleSorted, 95))],
      ["Warm-up", (warmup.streams || "—") + "× streams · " + (warmup.mbps ? warmup.mbps.toFixed(0) + " Mbps" : "—")],
      ["Down increase", fmtMs(downInc)],
      ["Down throughput", fmtMbps(downBytes, downMs)],
      ["Down probe-loss / jitter", fmtPct(lossPercent(down.failures, down.attempts)) + " / " + fmtMs(jitterMs(down.samples))],
      ["Down RPM (SLA)", fmtRpm(rpmFrom(down.rpmSuccess, down.durationMs))],
      ["Up increase", fmtMs(upInc)],
      ["Up throughput", fmtMbps(upBytes, upMs)],
      ["Up probe-loss / jitter", fmtPct(lossPercent(up.failures, up.attempts)) + " / " + fmtMs(jitterMs(up.samples))],
      ["Up RPM (SLA)", fmtRpm(rpmFrom(up.rpmSuccess, up.durationMs))],
      ["Both increase", fmtMs(biInc)],
      ["Both throughput", fmtMbps(biBytes, biMs)],
      ["Both probe-loss / jitter", fmtPct(lossPercent(bi.failures, bi.attempts)) + " / " + fmtMs(jitterMs(bi.samples))],
      ["Both RPM (SLA)", fmtRpm(rpmFrom(bi.rpmSuccess, bi.durationMs))],
      ["Loaded probe-loss", fmtPct(loadedLoss)],
      ["Loaded RPM (SLA)", fmtRpm(loadedRpm)],
      ["Recovery (3× near idle)", Number.isNaN(recUntil) ? "> " + PHASE.recovery.durationMs + " ms" : fmtMs(recUntil)],
      ["Recovery p50", fmtMs(percentile([...recovery.samples].sort((a, b) => a - b), 50))],
    ];

    el.cards.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="card"><span class="label">${label}</span><div class="value">${value}</div></div>`
      )
      .join("");

    el.results.hidden = false;
    if (totalPingFailures > 0) {
      el.warning.hidden = false;
      el.warning.textContent =
        "Warning: " + totalPingFailures + " probe failure(s) — loss/RPM reflect that.";
    } else {
      el.warning.hidden = true;
    }
  }

  async function runTest() {
    totalPingFailures = 0;
    el.start.disabled = true;
    if (el.startLabel) el.startLabel.textContent = "Running";
    if (el.heroStage) el.heroStage.classList.add("is-running");
    el.results.hidden = true;
    el.live.hidden = false;
    resetChart();

    sessionId = uuid();
    try {
      await beginTest(sessionId);
    } catch (e) {
      el.status.textContent =
        e.code === 409 ? "Busy — another test is running. Try again shortly." : "Failed to start: " + e.message;
      el.start.disabled = false;
      if (el.startLabel) el.startLabel.textContent = "Start test";
      if (el.heroStage) el.heroStage.classList.remove("is-running");
      sessionId = null;
      return;
    }

    const t0 = performance.now();
    try {
      // Baseline without RPM bursts — keep idle P50 clean for recovery threshold.
      const idle = await runPhase("baseline", PHASE.baseline, t0, { rpm: false });
      const idleP50 = percentile([...idle.samples].sort((a, b) => a - b), 50);

      const warmup = await runWarmup(t0, idleP50);

      // Drain queues before scored phases so warm-up does not inflate grades.
      await runPhase("warmup", PHASE.drain, t0, {
        durationMs: PHASE.drain.durationMs,
        idleP50,
        rpm: false,
        holdPhaseRail: true,
      });

      const downBytes = { value: 0, tStart: performance.now() };
      const down = await runPhase("download", PHASE.download, t0, {
        rpm: true,
        idleP50,
        bytesRef: downBytes,
        loadFn: () => startDownloadLoad(downBytes, downloadStreams, chunkBytes),
      });
      const downMs = down.durationMs;

      await runPhase("download", PHASE.drain, t0, {
        durationMs: 1000,
        idleP50,
        rpm: false,
        holdPhaseRail: true,
      });

      const upBytes = { value: 0, tStart: performance.now() };
      const up = await runPhase("upload", PHASE.upload, t0, {
        rpm: true,
        idleP50,
        bytesRef: upBytes,
        loadFn: () => startUploadLoad(upBytes, uploadStreams, chunkBytes),
      });
      const upMs = up.durationMs;

      await runPhase("upload", PHASE.drain, t0, {
        durationMs: 1000,
        idleP50,
        rpm: false,
        holdPhaseRail: true,
      });

      const biDownStreams = Math.max(1, Math.ceil(downloadStreams / 2));
      const biUpStreams = Math.max(1, Math.min(uploadStreams, biDownStreams));
      const biBytes = { value: 0, tStart: performance.now() };
      const bi = await runPhase("bidir", PHASE.bidir, t0, {
        rpm: true,
        idleP50,
        bytesRef: biBytes,
        loadFn: () => {
          const a = startDownloadLoad(biBytes, biDownStreams, chunkBytes);
          const b = startUploadLoad(biBytes, biUpStreams, chunkBytes);
          return () => {
            a();
            b();
          };
        },
      });
      const biMs = bi.durationMs;

      const recovery = await runPhase("recovery", PHASE.recovery, t0, {
        rpm: false,
        idleP50,
      });

      setPhaseUI("recovery", PHASE.cooldown);
      el.status.textContent = "Computing results…";
      if (el.phaseBar) el.phaseBar.style.width = "100%";
      el.phaseRail.querySelectorAll(".phase-step").forEach((n) => {
        n.classList.remove("active");
        n.classList.add("done");
      });
      await new Promise((r) => setTimeout(r, PHASE.cooldown.durationMs));

      renderResults({
        idle,
        down,
        up,
        bi,
        recovery,
        downBytes: downBytes.value,
        downMs,
        upBytes: upBytes.value,
        upMs,
        biBytes: biBytes.value,
        biMs,
        warmup,
      });
      el.status.textContent = "Done";
    } catch (e) {
      el.status.textContent = "Test failed: " + e.message;
      el.warning.hidden = false;
      el.warning.textContent = "Test ended early.";
    } finally {
      stopLoads();
      await endTest(sessionId);
      sessionId = null;
      el.start.disabled = false;
      if (el.startLabel) el.startLabel.textContent = "Start test";
      if (el.heroStage) el.heroStage.classList.remove("is-running");
    }
  }

  el.start.addEventListener("click", runTest);
  updateGauges(0, 0);
  loadConfig();
})();
