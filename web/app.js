(() => {
  const PHASE = {
    baseline: { name: "Baseline", color: "#5b8def", durationMs: 5000 },
    download: { name: "Download load", color: "#3dd6c6", durationMs: 10000 },
    upload: { name: "Upload load", color: "#f4a261", durationMs: 10000 },
    cooldown: { name: "Analysis", color: "#8b9bb0", durationMs: 3000 },
  };

  const CHUNK = 2 * 1024 * 1024; // 2 MiB per request piece
  const PING_EVERY_MS = 200;

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
    results: document.getElementById("results"),
    cards: document.getElementById("resultCards"),
    warning: document.getElementById("warning"),
    gradeOverall: document.querySelector("#gradeOverall .grade"),
    gradeOverallCard: document.getElementById("gradeOverall"),
    gradeCaption: document.getElementById("gradeCaption"),
    gradeDown: document.querySelector("#gradeDown .grade"),
    gradeUp: document.querySelector("#gradeUp .grade"),
    bloatDown: document.getElementById("bloatDown"),
    bloatUp: document.getElementById("bloatUp"),
    bloatDownLabel: document.getElementById("bloatDownLabel"),
    bloatUpLabel: document.getElementById("bloatUpLabel"),
    latencyGauge: document.getElementById("latencyGauge"),
    speedGauge: document.getElementById("speedGauge"),
  };

  let gaugeLatency = 0;
  let gaugeSpeed = 0;
  let phaseProgress = 0;

  let chartPoints = [];
  let downloadStreams = 4;
  // Upload is client-CPU heavy; fewer streams keep latency probes honest.
  let uploadStreams = 2;
  let abortControllers = [];
  let pingFailures = 0;
  let sessionId = null;
  let uploadBlob = null;
  let pingWorker = null;
  let pingSeq = 0;
  const pingWaiters = new Map();

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
        /* fall back to main-thread ping */
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

  function increaseMs(idleSamples, loadedSamples) {
    const idle = [...idleSamples].sort((a, b) => a - b);
    const loaded = [...loadedSamples].sort((a, b) => a - b);
    const delta = percentile(loaded, 90) - percentile(idle, 5);
    if (Number.isNaN(delta)) return NaN;
    return delta < 2 ? 0 : delta;
  }

  function fmtMs(v) {
    if (Number.isNaN(v)) return "—";
    return v.toFixed(1) + " ms";
  }

  function fmtMbps(bytes, ms) {
    if (!ms || ms <= 0) return "—";
    return ((bytes * 8) / (ms / 1000) / 1e6).toFixed(1) + " Mbps";
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
    } catch (_) {
      /* defaults */
    }
  }

  function sessionHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (sessionId) h["X-Session-Id"] = sessionId;
    return h;
  }

  async function pingOnceMain() {
    const t0 = performance.now();
    const r = await fetch("/ping?t=" + t0, {
      cache: "no-store",
      headers: sessionHeaders(),
    });
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
    const end = 2 * Math.PI;
    const t = Math.max(0, Math.min(1, value / max));

    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a2733";
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();

    const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "#ffffff88");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + Math.PI * t);
    ctx.stroke();

    // glow tip
    const ang = start + Math.PI * t;
    const tipX = cx + Math.cos(ang) * r;
    const tipY = cy + Math.sin(ang) * r;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.arc(tipX, tipY, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#7d8fa3";
    ctx.font = "600 10px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(unit, cx, cy - 8);
  }

  function updateGauges(latencyMs, mbps) {
    if (typeof latencyMs === "number" && !Number.isNaN(latencyMs)) {
      gaugeLatency = latencyMs;
    }
    if (typeof mbps === "number" && !Number.isNaN(mbps)) {
      gaugeSpeed = mbps;
    }
    drawArcGauge(el.latencyGauge, gaugeLatency, 200, "#5b9dff", "ms scale");
    drawArcGauge(el.speedGauge, gaugeSpeed, Math.max(100, gaugeSpeed * 1.2), "#2ee6c5", "Mbps scale");
  }

  function setPhaseUI(key, meta) {
    const order = ["baseline", "download", "upload", "cooldown"];
    const idx = order.indexOf(key);
    phaseProgress = ((idx + 0.5) / order.length) * 100;
    if (el.phaseBar) el.phaseBar.style.width = phaseProgress + "%";
    if (el.phaseRail) {
      el.phaseRail.querySelectorAll(".phase-step").forEach((node) => {
        const p = node.getAttribute("data-phase");
        node.classList.remove("active", "done");
        const pi = order.indexOf(p);
        if (pi === idx) node.classList.add("active");
        else if (pi < idx) node.classList.add("done");
      });
    }
    if (meta) {
      el.phase.textContent = meta.name;
      const hints = {
        baseline: "Measuring idle RTT",
        download: "Saturating downlink",
        upload: "Saturating uplink",
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

    // subtle grid
    ctx.strokeStyle = "#1a2733";
    ctx.lineWidth = 1;
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
    const padL = 8;
    const padR = 8;
    const padT = 12;
    const padB = 22;
    const mapX = (x) => padL + (x / maxX) * (cssW - padL - padR);
    const mapY = (y) => padT + (1 - y / maxY) * (cssH - padT - padB);

    // area fill under last color segments
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

    // latest point pulse
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

  function parseMbps(text) {
    const m = /([\d.]+)\s*Mbps/.exec(text || "");
    return m ? parseFloat(m[1]) : NaN;
  }

  async function beginTest(sessionId) {
    const r = await fetch("/test/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (r.status === 409) {
      const err = new Error("busy");
      err.code = 409;
      throw err;
    }
    if (!r.ok) throw new Error("begin failed");
  }

  async function endTest(sessionId) {
    try {
      await fetch("/test/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch (_) {
      /* ignore */
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

  function startDownloadLoad(bytesRef) {
    const controllers = [];
    for (let i = 0; i < downloadStreams; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      abortControllers.push(ac);
      (async () => {
        while (!ac.signal.aborted) {
          try {
            const r = await fetch("/download?size=" + CHUNK + "&n=" + Math.random(), {
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

  // Cheap semi-random Blob (no crypto). Crypto.getRandomValues on multi-MiB
  // payloads spikes CPU and can skew latency-under-load measurements.
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

  function startUploadLoad(bytesRef) {
    const controllers = [];
    const blob = getUploadBlob(CHUNK);
    const n = Math.max(1, uploadStreams);
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
              // Avoid JSON parse / body copy — count known size, drop response.
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

  async function runPhase(key, meta, samples, t0, bytesRef, loadFn) {
    setPhaseUI(key, meta);
    el.status.textContent = meta.name + "…";
    let stopLoad = null;
    if (loadFn) stopLoad = loadFn(bytesRef);

    const endAt = performance.now() + meta.durationMs;
    while (performance.now() < endAt) {
      try {
        const ms = await pingOnce();
        samples.push(ms);
        el.liveLatency.textContent = fmtMs(ms);
        addChartPoint((performance.now() - t0) / 1000, ms, meta.color);
        let mbps = NaN;
        if (bytesRef) {
          const elapsed = performance.now() - (bytesRef.tStart || t0);
          const text = fmtMbps(bytesRef.value, elapsed);
          el.liveThroughput.textContent = text;
          mbps = parseMbps(text);
        } else {
          el.liveThroughput.textContent = "—";
        }
        updateGauges(ms, mbps);
      } catch (_) {
        pingFailures += 1;
      }
      await new Promise((r) => setTimeout(r, PING_EVERY_MS));
    }
    if (stopLoad) stopLoad();
    stopLoads();
  }

  function renderResults(idle, down, up, downBytes, downMs, upBytes, upMs) {
    const idleSorted = [...idle].sort((a, b) => a - b);
    const downSorted = [...down].sort((a, b) => a - b);
    const upSorted = [...up].sort((a, b) => a - b);

    const downInc = increaseMs(idle, down);
    const upInc = increaseMs(idle, up);
    const gDown = gradeForIncrease(downInc);
    const gUp = gradeForIncrease(upInc);
    const gAll = worseGrade(gDown, gUp);

    el.gradeOverall.textContent = gAll;
    el.gradeDown.textContent = gDown;
    el.gradeUp.textContent = gUp;
    if (el.gradeCaption) el.gradeCaption.textContent = gradeCaption(gAll);
    if (el.gradeOverallCard) {
      el.gradeOverallCard.className = "medal " + gradeClass(gAll);
    }
    if (el.bloatDown) el.bloatDown.style.width = bloatWidth(downInc) + "%";
    if (el.bloatUp) el.bloatUp.style.width = bloatWidth(upInc) + "%";
    if (el.bloatDownLabel) el.bloatDownLabel.textContent = "bloat +" + fmtMs(downInc);
    if (el.bloatUpLabel) el.bloatUpLabel.textContent = "bloat +" + fmtMs(upInc);

    const rows = [
      ["Idle p50", fmtMs(percentile(idleSorted, 50))],
      ["Idle p95", fmtMs(percentile(idleSorted, 95))],
      ["Down loaded p50", fmtMs(percentile(downSorted, 50))],
      ["Down loaded p95", fmtMs(percentile(downSorted, 95))],
      ["Down increase", fmtMs(downInc)],
      ["Down throughput", fmtMbps(downBytes, downMs)],
      ["Up loaded p50", fmtMs(percentile(upSorted, 50))],
      ["Up loaded p95", fmtMs(percentile(upSorted, 95))],
      ["Up increase", fmtMs(upInc)],
      ["Up throughput", fmtMbps(upBytes, upMs)],
    ];

    el.cards.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="card"><span class="label">${label}</span><div class="value">${value}</div></div>`
      )
      .join("");

    el.results.hidden = false;
    if (pingFailures > 0) {
      el.warning.hidden = false;
      el.warning.textContent =
        "Warning: " + pingFailures + " ping sample(s) failed — results may be partial.";
    } else {
      el.warning.hidden = true;
    }
  }

  async function runTest() {
    pingFailures = 0;
    el.start.disabled = true;
    if (el.startLabel) el.startLabel.textContent = "Running";
    if (el.heroStage) el.heroStage.classList.add("is-running");
    el.results.hidden = true;
    el.live.hidden = false;
    resetChart();
    setPhaseUI("baseline", PHASE.baseline);

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

    const idle = [];
    const down = [];
    const up = [];
    const t0 = performance.now();
    const downBytes = { value: 0, tStart: 0 };
    const upBytes = { value: 0, tStart: 0 };
    let downMs = 0;
    let upMs = 0;

    try {
      await runPhase("baseline", PHASE.baseline, idle, t0, null, null);

      downBytes.tStart = performance.now();
      await runPhase("download", PHASE.download, down, t0, downBytes, startDownloadLoad);
      downMs = performance.now() - downBytes.tStart;

      upBytes.tStart = performance.now();
      await runPhase("upload", PHASE.upload, up, t0, upBytes, startUploadLoad);
      upMs = performance.now() - upBytes.tStart;

      setPhaseUI("cooldown", PHASE.cooldown);
      el.status.textContent = "Computing results…";
      if (el.phaseBar) el.phaseBar.style.width = "100%";
      await new Promise((r) => setTimeout(r, PHASE.cooldown.durationMs));

      renderResults(idle, down, up, downBytes.value, downMs, upBytes.value, upMs);
      el.status.textContent = "Done";
    } catch (e) {
      el.status.textContent = "Test failed: " + e.message;
      el.warning.hidden = false;
      el.warning.textContent = "Test ended early; showing partial data if available.";
      if (idle.length || down.length || up.length) {
        renderResults(
          idle,
          down,
          up,
          downBytes.value,
          downMs || NaN,
          upBytes.value,
          upMs || NaN
        );
      }
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
