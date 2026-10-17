/* Latency probes run off the main thread so download/upload fetch
   activity does not inflate RTT samples (LibreQoS-style). */
self.onmessage = async (ev) => {
  const { id, url, sessionId } = ev.data || {};
  const t0 = performance.now();
  try {
    const headers = {};
    if (sessionId) headers["X-Session-Id"] = sessionId;
    const r = await fetch(url, { cache: "no-store", headers });
    if (!r.ok) throw new Error("bad status");
    await r.arrayBuffer();
    self.postMessage({ id, ok: true, ms: performance.now() - t0 });
  } catch (_) {
    self.postMessage({ id, ok: false, ms: 0 });
  }
};
