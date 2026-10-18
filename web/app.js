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
  let chunkBytes = 8 * 1024 * 1024;
  let uploadChunkBytes = 4 * 1024 * 1024;
  let abortControllers = [];
  let sessionId = null;
  let uploadBlob = null;
  let pingWorker = null;
  let pingSeq = 0;
  const pingWaiters = new Map();
  let totalPingFailures = 0;
  let runController = null;
  let runWarnings = [];
  let loadJobs = [];
  const stopButton = document.getElementById("stopBtn");
  const labelInput = document.getElementById("runLabel");
  const repeatInput = document.getElementById("repeatRuns");
  const expectedDownInput = document.getElementById("expectedDownload");
  const expectedUpInput = document.getElementById("expectedUpload");
  const runProgress = document.getElementById("repeatStatus");
  const historyKey = "bufferbloat-runs-v1";
  let history = [];
  try { history = TestResults.readHistory(localStorage.getItem(historyKey)); }
  catch (_) { document.getElementById("historyNotice").textContent = "Browser storage unavailable; export runs to keep them."; }

  function abortError() { return new DOMException("Test stopped", "AbortError"); }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(done, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortError()); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async function request(url, options = {}, signal = runController?.signal, timeout = 5000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) { const error = new Error("HTTP " + response.status); error.code = response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }


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
        const failed = pingWorker;
        pingWorker = null;
        failed?.terminate();
        for (const waiter of [...pingWaiters.values()]) waiter.reject(new Error("probe worker failed"));
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

  function fmtLiveMbps(mbps) {
    return Number.isFinite(mbps) ? mbps.toFixed(1) + " Mbps" : "Measuring…";
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

  async function pingOnceMain(signal, timeoutMs) {
    const t0 = performance.now();
    await request("/ping?t=" + t0, { cache: "no-store", headers: sessionHeaders() }, signal, timeoutMs);
    return performance.now() - t0;
  }

  function pingOnce(signal, timeoutMs = 5000) {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = ensurePingWorker();
    if (!worker) return pingOnceMain(signal, timeoutMs);
    const id = ++pingSeq;
    return new Promise((resolve, reject) => {
      const finish = (error, ms) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pingWaiters.delete(id);
        if (error) reject(error); else resolve(ms);
      };
      const abort = () => {
        worker.postMessage({ id, cancel: true });
        finish(abortError());
      };
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      pingWaiters.set(id, { resolve: ms => finish(null, ms), reject: error => finish(error) });
      worker.postMessage({ id, url: "/ping?t=" + performance.now(), sessionId, timeoutMs });
    });
  }

  /** Parallel small probes for RPM-style responsiveness under load. */
  async function rpmBurst(n, budgetMs, signal) {
    const jobs = [];
    for (let i = 0; i < n; i++) {
      jobs.push(
        (async () => {
          try {
            const ms = await pingOnce(signal);
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

  function drawArcGauge(canvas, value, max, color, unit, downloadShare = null) {
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
    if (downloadShare !== null && t > 0) {
      ctx.lineCap = "butt";
      const split = start + Math.PI * t * downloadShare;
      ctx.strokeStyle = PHASE.download.color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, split);
      ctx.stroke();
      ctx.strokeStyle = PHASE.upload.color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, split, start + Math.PI * t);
      ctx.stroke();
      color = downloadShare < 1 ? PHASE.upload.color : PHASE.download.color;
    }
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

  function updateGauges(latencyMs, mbps, direction = "download", downloadShare = null) {
    if (typeof latencyMs === "number" && !Number.isNaN(latencyMs)) gaugeLatency = latencyMs;
    if (typeof mbps === "number" && !Number.isNaN(mbps)) gaugeSpeed = mbps;
    drawArcGauge(el.latencyGauge, gaugeLatency, 200, "#5b9dff", "ms scale");
    drawArcGauge(el.speedGauge, gaugeSpeed, Math.max(100, gaugeSpeed * 1.2), PHASE[direction].color, "Mbps scale", downloadShare);
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
    return request("/test/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) });
  }

  async function endTest(id) {
    try {
      await request("/test/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }, null, 2000);
    } catch (_) {
      el.status.textContent += " — session release unconfirmed; server lock expires automatically.";
    }
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
    const n = Math.max(1, streams);
    const sz = size || chunkBytes;
    for (let i = 0; i < n; i++) {
      const ac = new AbortController();
      abortControllers.push(ac);
      loadJobs.push((async () => {
        while (!ac.signal.aborted) {
          try {
            const r = await fetch("/download?size=" + sz + "&n=" + Math.random(), {
              cache: "no-store",
              signal: ac.signal,
              headers: sessionHeaders(),
            });
            if (!r.ok || !r.body) {
              bytesRef.errors += 1;
              if (r.body) await r.body.cancel();
              await new Promise((res) => setTimeout(res, 100));
              continue;
            }
            const reader = r.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytesRef.down += value.byteLength;
              bytesRef.value = bytesRef.down + bytesRef.up;
            }
          } catch (_) {
            if (ac.signal.aborted) return;
            bytesRef.errors += 1;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })());
    }
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

  function startUploadLoad(bytesRef, streams, size, phase) {
    const blob = getUploadBlob(size || chunkBytes);
    const n = Math.max(1, streams);
    for (let i = 0; i < n; i++) {
      const ac = new AbortController();
      abortControllers.push(ac);
      loadJobs.push((async () => {
        while (!ac.signal.aborted) {
          try {
            const r = await fetch("/upload?phase=" + phase, {
              method: "POST",
              body: blob,
              signal: ac.signal,
              headers: sessionHeaders(),
            });
            if (r.ok) {
              if (r.body) {
                try {
                  await r.body.cancel();
                } catch (_) {}
              }
            } else {
              bytesRef.errors += 1;
              if (r.body) await r.body.cancel();
              await new Promise(r => setTimeout(r, 100));
            }
          } catch (_) {
            if (ac.signal.aborted) return;
            bytesRef.errors += 1;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })());
    }
  }

  function emptyStats() {
    return { samples: [], recoverySamples: [], sampleTimes: [], downBytes: 0, upBytes: 0, loadErrors: 0, attempts: 0, failures: 0, rpmSuccess: 0, rpmAttempts: 0, durationMs: 0 };
  }

  function updateLiveExtras(stats) {
    const loss = lossPercent(stats.failures, stats.attempts);
    const jit = TestResults.jitterMs(stats.samples);
    const rpmDur = Math.max(stats.durationMs, 500);
    const rpm = rpmFrom(stats.rpmSuccess, rpmDur);
    if (el.liveLoss) el.liveLoss.textContent = fmtPct(loss);
    if (el.liveJitter) el.liveJitter.textContent = fmtMs(jit);
    if (el.liveRpm) el.liveRpm.textContent = fmtRpm(rpm);
  }

  function recoveryStableMs(stats, baselineP50, slackMs, need) {
    return TestResults.recovery(stats, baselineP50, slackMs, need);
  }

  async function uploadStats(phase, settled = false) {
    const deadline = performance.now() + 2000;
    for (;;) {
      const stats = await request("/test/stats?phase=" + phase, { cache: "no-store", headers: sessionHeaders() }, runController?.signal, Math.max(1, deadline - performance.now()));
      if (!Number.isFinite(stats.bytes) || stats.bytes < 0 || !Number.isInteger(stats.active) || stats.active < 0) throw new Error("invalid upload byte count");
      if (!settled || stats.active === 0) return stats.bytes;
      if (performance.now() >= deadline) throw new Error("upload did not stop");
      await delay(20, runController?.signal);
    }
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

    // Calibration and scored upload phases share a counter; measure only this phase's delta.
    const uploadStart = opts.uploadPhase ? await uploadStats(opts.uploadPhase, true) : 0;
    const controller = new AbortController();
    let stoppedAt = 0;
    const abort = () => { stoppedAt = stoppedAt || performance.now(); controller.abort(); };
    if (runController.signal.aborted) throw abortError();
    runController.signal.addEventListener("abort", abort, { once: true });
    const phaseStart = performance.now();
    const timer = setTimeout(abort, opts.durationMs || meta.durationMs);
    const signal = controller.signal;
    signal.addEventListener("abort", stopLoads, { once: true });
    if (bytesRef) Object.assign(bytesRef, { down: 0, up: 0, errors: 0 });
    let lastStats = phaseStart;
    const downRate = TestResults.liveRate(phaseStart);
    const upRate = TestResults.liveRate(phaseStart);
    let downMbps = 0, upMbps = opts.uploadPhase ? NaN : 0;
    const both = key === "bidir";
    document.getElementById("throughputDirections").hidden = !both;
    el.liveThroughput.textContent = bytesRef ? "Measuring…" : "—";
    document.getElementById("liveDownload").textContent = "Measuring…";
    document.getElementById("liveUpload").textContent = "Measuring…";
    updateGauges(0, 0);

    try {
      if (opts.loadFn) opts.loadFn();
      while (!signal.aborted) {
        try {
          const ms = await pingOnce(signal);
          if (signal.aborted) break;
          stats.attempts += 1;
          stats.samples.push(ms);
          stats.recoverySamples.push(ms);
          stats.sampleTimes.push(performance.now() - (opts.sampleOrigin || phaseStart));
          el.liveLatency.textContent = fmtMs(ms);
          addChartPoint((performance.now() - t0) / 1000, ms, meta.color);
          if (opts.rpm) {
            const burst = await rpmBurst(RPM_PARALLEL, rpmBudget, signal);
            if (!signal.aborted) {
              stats.attempts += burst.total;
              stats.rpmAttempts += burst.total;
              stats.rpmSuccess += burst.slaOk;
              stats.failures += burst.transportFail;
              totalPingFailures += burst.transportFail;
            }
          }
        } catch (_) {
          if (signal.aborted) break;
          stats.attempts += 1;
          stats.failures += 1;
          stats.recoverySamples.push(NaN);
          stats.sampleTimes.push(performance.now() - (opts.sampleOrigin || phaseStart));
          totalPingFailures += 1;
        }
        if (opts.uploadPhase && performance.now() - lastStats > 1000) {
          try {
            bytesRef.up = await uploadStats(opts.uploadPhase) - uploadStart;
            upMbps = upRate(bytesRef.up, performance.now());
          }
          catch (_) { if (!runController.signal.aborted) bytesRef.errors += 1; }
          lastStats = performance.now();
        }
        let mbps = 0;
        if (bytesRef) {
          bytesRef.value = bytesRef.down + bytesRef.up;
          downMbps = opts.uploadPhase && !both ? 0 : downRate(bytesRef.down, performance.now());
          mbps = downMbps + upMbps;
          el.liveThroughput.textContent = fmtLiveMbps(mbps);
          if (both) {
            document.getElementById("liveDownload").textContent = fmtLiveMbps(downMbps);
            document.getElementById("liveUpload").textContent = fmtLiveMbps(upMbps);
          }
        } else el.liveThroughput.textContent = "—";
        stats.durationMs = performance.now() - phaseStart;
        updateLiveExtras(stats);
        updateGauges(stats.samples[stats.samples.length - 1] || 0, mbps, opts.uploadPhase && !both ? "upload" : "download", both ? (mbps > 0 ? downMbps / mbps : 0) : null);
        await delay(PING_EVERY_MS, signal).catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      abort();
      stopLoads();
      await Promise.allSettled(loadJobs);
      loadJobs = [];
      runController.signal.removeEventListener("abort", abort);
    }
    stats.stoppedAt = stoppedAt;
    stats.durationMs = stoppedAt - phaseStart;
    stats.observationMs = stoppedAt - (opts.sampleOrigin || phaseStart);
    if (runController.signal.aborted) throw abortError();
    if (opts.uploadPhase) {
      try { bytesRef.up = await uploadStats(opts.uploadPhase, true) - uploadStart; }
      catch (_) { bytesRef.errors += 1; }
    }
    if (bytesRef) {
      bytesRef.value = bytesRef.down + bytesRef.up;
      stats.downBytes = bytesRef.down;
      stats.upBytes = bytesRef.up;
      stats.loadErrors = bytesRef.errors;
    }
    return stats;
  }

  async function runWarmup(t0, idleP50, download, initialStreams) {
    const name = download ? "Download calibration" : "Upload calibration";
    let streams = Math.max(1, Math.min(initialStreams, download ? 5 : 3));
    let size = (download ? 8 : 4) * 1024 * 1024;
    const best = { streams, chunk: size, mbps: 0, status: "unconfirmed" };
    const speeds = [];
    let failed = false;
    for (let step = 0; step < 3; step++) {
      const bytesRef = { value: 0 };
      const stats = await runPhase("warmup", { ...PHASE.warmup, name: name + " · step " + (step + 1) }, t0, {
        durationMs: 2000, idleP50, bytesRef,
        uploadPhase: download ? null : "upload",
        loadFn: () => download ? startDownloadLoad(bytesRef, streams, size) : startUploadLoad(bytesRef, streams, size, "upload"),
      });
      const mbps = stats.loadErrors ? NaN : bytesRef.value * 8 / stats.durationMs / 1000;
      failed ||= stats.loadErrors > 0;
      speeds.push(mbps);
      if (mbps > best.mbps) Object.assign(best, { mbps, streams, chunk: size });
      best.status = TestResults.calibrationStatus(speeds);
      if (best.status === "plateau") break;
      streams = Math.min(download ? 5 : 3, streams + 1);
      size *= 2;
    }
    if (failed) best.status = "unconfirmed";
    return best;
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
      warmup, uploadWarmup, settings, index, count, seriesId,
    } = ctx;

    const idleSorted = [...idle.samples].sort((a, b) => a - b);
    const idleP50 = percentile(idleSorted, 50);

    const downInc = increaseMs(idle.samples, down.samples);
    const upInc = increaseMs(idle.samples, up.samples);
    const biInc = increaseMs(idle.samples, bi.samples);
    const warnings = [...runWarnings];
    const saturationDown = TestResults.saturationWarnings(warmup.status, down.downBytes * 8 / downMs / 1000, settings.expectedDown);
    const saturationUp = TestResults.saturationWarnings(uploadWarmup.status, up.upBytes * 8 / upMs / 1000, settings.expectedUp);
    function checkedGrade(stats, downLoad, upLoad, inc, name) {
      const reasons = TestResults.quality(idle, stats, downLoad, upLoad);
      if (reasons.length) warnings.push(name + ": " + reasons.join("; ") + ". Grade withheld.");
      if (stats.failures) warnings.push(name + ": HTTP probe failures; latency uses successful probes only.");
      return reasons.length || runWarnings.length ? "—" : gradeForIncrease(inc);
    }
    const gDown = checkedGrade(down, true, false, downInc, "Download");
    const gUp = checkedGrade(up, false, true, upInc, "Upload");
    const gBi = checkedGrade(bi, true, true, biInc, "Bidirectional");
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
      ["Download calibration", warmup.streams + "× · " + warmup.mbps.toFixed(1) + " Mbps · " + warmup.status],
      ["Upload calibration", uploadWarmup.streams + "× · " + uploadWarmup.mbps.toFixed(1) + " Mbps · " + uploadWarmup.status],
      ["Down increase", fmtMs(downInc)],
      ["Down throughput", fmtMbps(downBytes, downMs)],
      ["Down probe-loss / smoothed RTT jitter", fmtPct(lossPercent(down.failures, down.attempts)) + " / " + fmtMs(TestResults.jitterMs(down.samples))],
      ["Down RPM (SLA)", fmtRpm(rpmFrom(down.rpmSuccess, down.durationMs))],
      ["Up increase", fmtMs(upInc)],
      ["Up throughput", fmtMbps(upBytes, upMs)],
      ["Up probe-loss / smoothed RTT jitter", fmtPct(lossPercent(up.failures, up.attempts)) + " / " + fmtMs(TestResults.jitterMs(up.samples))],
      ["Up RPM (SLA)", fmtRpm(rpmFrom(up.rpmSuccess, up.durationMs))],
      ["Both increase", fmtMs(biInc)],
      ["Both download / upload", fmtMbps(bi.downBytes, biMs) + " / " + fmtMbps(bi.upBytes, biMs)],
      ["Both probe-loss / smoothed RTT jitter", fmtPct(lossPercent(bi.failures, bi.attempts)) + " / " + fmtMs(TestResults.jitterMs(bi.samples))],
      ["Both RPM (SLA)", fmtRpm(rpmFrom(bi.rpmSuccess, bi.durationMs))],
      ["Loaded probe-loss", fmtPct(loadedLoss)],
      ["Loaded RPM (SLA)", fmtRpm(loadedRpm)],
      ["Recovery (3× near idle)", Number.isNaN(recUntil) ? "> " + Math.round(recovery.observationMs) + " ms" : fmtMs(recUntil)],
      ["Recovery p50", fmtMs(percentile([...recovery.samples].sort((a, b) => a - b), 50))],
    ];

    el.cards.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="card"><span class="label">${label}</span><div class="value">${value}</div></div>`
      )
      .join("");

    el.results.hidden = false;
    if (totalPingFailures) warnings.push(totalPingFailures + " HTTP probe failure(s) across the run.");
    if (Number.isNaN(recUntil)) warnings.push("Recovery was not confirmed within the observation window.");
    el.warning.hidden = warnings.length === 0;
    el.warning.textContent = warnings.join(" ");
    const result = {
      version: 1, timestamp: new Date().toISOString(), label: count > 1 ? settings.label.slice(0, 70) + " (" + (index + 1) + "/" + count + ")" : settings.label,
      jitter_method: "rtt-ewma-1/16",
      series_id: seriesId, run_index: index + 1, requested_runs: count,
      expected_download_mbps: settings.expectedDown, expected_upload_mbps: settings.expectedUp,
      download_advisory: saturationDown.join(" "), upload_advisory: saturationUp.join(" "),
      download_calibration: warmup.status, upload_calibration: uploadWarmup.status,
      warmup_mbps: warmup.mbps, upload_warmup_mbps: uploadWarmup.mbps,
      upload_warmup_streams: uploadWarmup.streams, upload_warmup_chunk: uploadWarmup.chunk,
      server: location.origin, overall_grade: gAll,
      idle_p50_ms: idleP50, recovery_ms: recUntil, quality_warnings: warnings,
      warmup_streams: warmup.streams, warmup_chunk: warmup.chunk,
    };
    for (const [name, stats, inc, grade] of [["download", down, downInc, gDown], ["upload", up, upInc, gUp], ["bidir", bi, biInc, gBi]]) {
      Object.assign(result, {
        [name + "_grade"]: grade, [name + "_inc_ms"]: inc,
        [name + "_mbps"]: (stats.downBytes + stats.upBytes) * 8 / stats.durationMs / 1000,
        [name + "_loss_pct"]: lossPercent(stats.failures, stats.attempts),
        [name + "_jitter_ms"]: TestResults.jitterMs(stats.samples),
        [name + "_rpm"]: rpmFrom(stats.rpmSuccess, stats.durationMs),
        [name + "_samples"]: stats.samples.length, [name + "_load_errors"]: stats.loadErrors,
      });
    }
    result.bidir_download_mbps = bi.downBytes * 8 / biMs / 1000;
    result.bidir_upload_mbps = bi.upBytes * 8 / biMs / 1000;
    showSpeedFeedback("download", result.download_mbps, settings.expectedDown, result.download_advisory);
    showSpeedFeedback("upload", result.upload_mbps, settings.expectedUp, result.upload_advisory);
    // JSON turns unavailable numeric values into null for storage and export.
    history.push(JSON.parse(JSON.stringify(result)));
    history = history.slice(-20);
    try { localStorage.setItem(historyKey, JSON.stringify(history)); }
    catch (_) { document.getElementById("historyNotice").textContent = "Could not save runs in this browser. Export to keep this result."; }
    renderHistory();
  }

  function showSpeedFeedback(direction, measured, expected, advisory) {
    const node = document.getElementById(direction + "Feedback");
    const speed = Number.isFinite(measured) ? measured.toFixed(1) + " Mbps measured" : "Speed unavailable";
    node.textContent = "Last test: " + speed + (expected > 0 ? " / " + expected + " Mbps expected." : ".") + (advisory ? " " + advisory : "");
    node.classList.toggle("has-advisory", Boolean(advisory));
    node.hidden = false;
  }

  function updateSetup() {
    if (runController) return;
    if (el.startLabel) el.startLabel.textContent = repeatInput.checked ? "Start 3 tests" : "Start test";
    document.getElementById("durationHint").textContent = repeatInput.checked ? "About 3 minutes" : "About 1 minute";
    document.getElementById("testCost").textContent = repeatInput.checked ? "Three tests use roughly three times the data. You can stop at any time; completed tests are kept." : "Tests use your connection at full speed. Keep this tab visible.";
  }

  function renderHistory() {
    for (const id of ["beforeRun", "afterRun"]) {
      const select = document.getElementById(id);
      select.replaceChildren();
      history.forEach((run, i) => {
        const option = document.createElement("option");
        option.value = i;
        option.textContent = run.label + " — " + run.timestamp + " (" + run.overall_grade + ")";
        select.append(option);
      });
      select.disabled = !history.length;
    }
    document.getElementById("beforeRun").selectedIndex = Math.max(0, history.length - 2);
    document.getElementById("afterRun").selectedIndex = history.length - 1;
    document.getElementById("exportJSON").disabled = !history.length;
    document.getElementById("exportCSV").disabled = !history.length;
    document.getElementById("clearHistory").disabled = !history.length;
    renderComparison();
  }

  function renderComparison() {
    renderRepeatSummary();
    const host = document.getElementById("comparison");
    host.replaceChildren();
    const before = history[document.getElementById("beforeRun").value];
    const after = history[document.getElementById("afterRun").value];
    if (!before || !after) return;
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = "Before / after comparison — differences are after minus before";
    table.append(caption);
    const addRow = (values, header = false) => {
      const row = document.createElement("tr");
      values.forEach((value, i) => {
        const cell = document.createElement(header || i === 0 ? "th" : "td");
        if (header || i === 0) cell.scope = header ? "col" : "row";
        cell.textContent = value;
        row.append(cell);
      });
      table.append(row);
    };
    addRow(["Metric", before.label, after.label, "Difference"], true);
    const display = v => v == null ? "—" : typeof v === "number" ? v.toFixed(1) : v;
    for (const [key, label] of Object.entries(TestResults.fields)) {
      const a = before[key], b = after[key];
      const delta = typeof a === "number" && typeof b === "number" ? (b - a).toFixed(1) : "—";
      addRow([label, display(a), display(b), delta]);
    }
    for (const direction of ["download", "upload"]) {
      if (before[direction + "_advisory"] || after[direction + "_advisory"]) addRow([direction === "download" ? "Download note" : "Upload note", before[direction + "_advisory"] || "None", after[direction + "_advisory"] || "None", "—"]);
    }
    addRow(["Quality warnings", (before.quality_warnings || []).join("; ") || "None", (after.quality_warnings || []).join("; ") || "None", "—"]);
    host.append(table);
  }

  function selectedSeries() {
    const selected = history[document.getElementById("afterRun").value];
    if (!selected?.series_id || selected.requested_runs !== 3) return null;
    const runs = history.filter(r => r.series_id === selected.series_id);
    return { requested_runs: 3, completed_runs: runs.length, runs, summary: TestResults.summarize(runs) };
  }

  function renderRepeatSummary() {
    const report = selectedSeries();
    document.getElementById("repeatSummary").hidden = !report;
    const host = document.getElementById("repeatTable");
    host.replaceChildren();
    if (!report) return;
    const included = report.runs.filter(r => r.overall_grade !== "—").length;
    runProgress.textContent = report.completed_runs + " of 3 tests saved · " + included + " included in this summary." + (included === 1 ? " Complete another valid test to compare variation." : "");
    if (!included) { host.textContent = "No valid runs to summarize. Individual measurements and warnings remain in saved runs."; return; }
    const table = document.createElement("table");
    const row = (values, header) => {
      const tr = document.createElement("tr");
      values.forEach((value, i) => {
        const cell = document.createElement(header || i === 0 ? "th" : "td");
        if (header || i === 0) cell.scope = header ? "col" : "row";
        cell.textContent = value;
        tr.append(cell);
      });
      table.append(tr);
    };
    row(["Metric", "Median", "Min", "Max", "Spread", "Tests"], true);
    for (const [key, stats] of Object.entries(report.summary)) row([TestResults.fields[key], stats.median.toFixed(1), stats.min.toFixed(1), stats.max.toFixed(1), stats.spread.toFixed(1), stats.count], false);
    host.append(table);
  }

  function downloadResult(result, format, name) {
    const blob = new Blob([format === "json" ? JSON.stringify(result, null, 2) : TestResults.csv(result)], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name + "." + format;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportRun(format) {
    const result = history[document.getElementById("afterRun").value];
    if (result) downloadResult(result, format, "bufferbloat-" + result.timestamp.replace(/[^0-9T]/g, "-"));
  }

  async function runTest() {
    if (runController) return;
    for (const input of [expectedDownInput, expectedUpInput]) {
      if (!input.reportValidity()) return;
      if (input.value && (!Number.isFinite(Number(input.value)) || Number(input.value) <= 0)) { el.status.textContent = "Expected speeds must be positive numbers or blank."; return; }
    }
    const settings = { label: labelInput.value.trim().slice(0, 80) || "Untitled run", expectedDown: Number(expectedDownInput.value), expectedUp: Number(expectedUpInput.value), downStreams: downloadStreams, upStreams: uploadStreams };
    const count = repeatInput.checked ? 3 : 1;
    const seriesId = count > 1 ? uuid() : "";
    document.getElementById("repeatProgressPanel").hidden = count === 1;
    document.getElementById("repeatProgress").value = 0;
    document.getElementById("repeatProgressLabel").textContent = "0 of 3 tests completed";
    runController = new AbortController();
    stopButton.hidden = false;
    for (const input of [labelInput, repeatInput, expectedDownInput, expectedUpInput]) input.disabled = true;
    el.start.disabled = true;
    if (el.heroStage) el.heroStage.classList.add("is-running");
    let completed = 0;
    try {
      for (let i = 0; i < count; i++) {
        if (i > 0) {
          el.live.hidden = true;
          for (let seconds = 10; seconds > 0; seconds--) {
            el.status.textContent = "Cooldown — " + seconds + " s before run " + (i + 1) + "/" + count;
            await delay(1000, runController.signal);
          }
        }
        if (runController.signal.aborted) throw abortError();
        if (el.startLabel) el.startLabel.textContent = "Run " + (i + 1) + "/" + count;
        await runSingle(settings, i, count, seriesId);
        completed++;
        document.getElementById("repeatProgress").value = completed;
        document.getElementById("repeatProgressLabel").textContent = completed + " of " + count + " tests completed";
      }
      el.status.textContent = count > 1 ? "Done — 3/3 runs completed" : "Done";
    } catch (e) {
      el.status.textContent = runController.signal.aborted ? "Test stopped — " + completed + "/" + count + " completed runs saved." : e.code === 409 ? "Busy — another test is running. " + completed + " completed runs saved." : "Test failed: " + e.message + ". " + completed + " completed runs saved.";
    } finally {
      runController = null;
      stopButton.hidden = true;
      for (const input of [labelInput, repeatInput, expectedDownInput, expectedUpInput]) input.disabled = false;
      el.start.disabled = false;
      updateSetup();
      if (el.heroStage) el.heroStage.classList.remove("is-running");
    }
  }

  async function runSingle(settings, index, count, seriesId) {
    runWarnings = document.hidden ? ["Tab was hidden during this run. Grade withheld; repeat with the tab visible."] : [];
    totalPingFailures = 0;
    for (const direction of ["download", "upload"]) document.getElementById(direction + "Feedback").hidden = true;
    el.warning.hidden = true;
    el.results.hidden = true;
    el.live.hidden = false;
    resetChart();
    sessionId = uuid();
    const t0 = performance.now();
    try {
      await beginTest(sessionId);
      // Baseline without RPM bursts — keep idle P50 clean for recovery threshold.
      const idle = await runPhase("baseline", PHASE.baseline, t0, { rpm: false });
      const idleP50 = percentile([...idle.samples].sort((a, b) => a - b), 50);

      const warmup = await runWarmup(t0, idleP50, true, settings.downStreams);
      await runPhase("warmup", PHASE.drain, t0, { durationMs: 1000, idleP50, rpm: false, holdPhaseRail: true });
      const uploadWarmup = await runWarmup(t0, idleP50, false, settings.upStreams);
      chunkBytes = warmup.chunk;
      uploadChunkBytes = uploadWarmup.chunk;
      uploadBlob = null;

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
        loadFn: () => startDownloadLoad(downBytes, warmup.streams, chunkBytes),
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
        uploadPhase: "upload",
        loadFn: () => startUploadLoad(upBytes, uploadWarmup.streams, uploadChunkBytes, "upload"),
      });
      const upMs = up.durationMs;

      await runPhase("upload", PHASE.drain, t0, {
        durationMs: 1000,
        idleP50,
        rpm: false,
        holdPhaseRail: true,
      });

      const biDownStreams = Math.max(1, Math.ceil(warmup.streams / 2));
      const biUpStreams = Math.max(1, Math.min(uploadWarmup.streams, 5 - biDownStreams));
      const biBytes = { value: 0, tStart: performance.now() };
      const bi = await runPhase("bidir", PHASE.bidir, t0, {
        rpm: true,
        idleP50,
        bytesRef: biBytes,
        uploadPhase: "bidir",
        loadFn: () => {
          startDownloadLoad(biBytes, biDownStreams, chunkBytes);
          startUploadLoad(biBytes, biUpStreams, uploadChunkBytes, "bidir");
        },
      });
      const biMs = bi.durationMs;

      const recovery = await runPhase("recovery", PHASE.recovery, t0, {
        sampleOrigin: bi.stoppedAt,
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
      await delay(PHASE.cooldown.durationMs, runController.signal);

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
        warmup, uploadWarmup, settings, index, count, seriesId,
      });
    } finally {
      stopLoads();
      await Promise.allSettled(loadJobs);
      loadJobs = [];
      await endTest(sessionId);
      sessionId = null;
    }
  }

  repeatInput.addEventListener("change", updateSetup);
  for (const [input, direction] of [[expectedDownInput, "download"], [expectedUpInput, "upload"]]) {
    input.addEventListener("input", () => { document.getElementById(direction + "Feedback").hidden = true; });
  }
  updateSetup();
  stopButton.addEventListener("click", () => { runController?.abort(); stopLoads(); });
  document.addEventListener("visibilitychange", () => {
    if (runController && document.hidden && !runWarnings.length) runWarnings.push("Tab was hidden during this run. Grade withheld; repeat with the tab visible.");
  });
  window.addEventListener("pagehide", () => {
    if (!sessionId) return;
    runController?.abort();
    stopLoads();
    navigator.sendBeacon("/test/end", new Blob([JSON.stringify({ sessionId })], { type: "application/json" }));
  });
  for (const id of ["beforeRun", "afterRun"]) document.getElementById(id).addEventListener("change", renderComparison);
  document.getElementById("exportRepeat").addEventListener("click", () => {
    const report = selectedSeries();
    if (report) downloadResult(report, "json", "bufferbloat-repeat");
  });
  document.getElementById("exportJSON").addEventListener("click", () => exportRun("json"));
  document.getElementById("exportCSV").addEventListener("click", () => exportRun("csv"));
  document.getElementById("clearHistory").addEventListener("click", () => {
    history = [];
    try { localStorage.removeItem(historyKey); }
    catch (_) { document.getElementById("historyNotice").textContent = "Could not clear browser storage."; }
    renderHistory();
  });
  renderHistory();
  el.start.addEventListener("click", runTest);
  updateGauges(0, 0);
  loadConfig();
})();
