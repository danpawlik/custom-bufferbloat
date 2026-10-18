/* Cancel the network request itself, not just the caller's promise. */
const pending = new Map();
self.onmessage = async (ev) => {
  const { id, url, sessionId, cancel, timeoutMs = 5000 } = ev.data || {};
  if (cancel) { pending.get(id)?.abort(); return; }
  const controller = new AbortController();
  pending.set(id, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const headers = sessionId ? { "X-Session-Id": sessionId } : {};
    const r = await fetch(url, { cache: "no-store", headers, signal: controller.signal });
    if (!r.ok) throw new Error("bad status");
    await r.arrayBuffer();
    self.postMessage({ id, ok: true, ms: performance.now() - t0 });
  } catch (_) {
    self.postMessage({ id, ok: false, ms: 0 });
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
};
