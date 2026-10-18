/* Pure result helpers are shared by the UI and the Node regression checks. */
(() => {
  const fields = {
    overall_grade: "Overall grade",
    idle_p50_ms: "Idle p50 (ms)",
    download_mbps: "Download (Mbps)", upload_mbps: "Upload (Mbps)",
    download_inc_ms: "Download increase (ms)", upload_inc_ms: "Upload increase (ms)",
    bidir_inc_ms: "Both increase (ms)",
    bidir_download_mbps: "Both: download (Mbps)", bidir_upload_mbps: "Both: upload (Mbps)",
    download_loss_pct: "Download probe loss (%)", upload_loss_pct: "Upload probe loss (%)",
    bidir_loss_pct: "Both probe loss (%)", recovery_ms: "Recovery (ms)",
  };
  function quality(idle, loaded, down, up) {
    const reasons = [];
    if (idle.samples.length < 5 || loaded.samples.length < 5) reasons.push("fewer than 5 latency samples");
    if (loaded.loadErrors) reasons.push("load requests or byte accounting failed");
    if (down && !(loaded.downBytes > 0)) reasons.push("no download data received");
    if (up && !(loaded.upBytes > 0)) reasons.push("no upload data received");
    return reasons;
  }
  function recovery(stats, baseline, slack, need) {
    if (!Number.isFinite(baseline)) return NaN;
    let streak = 0;
    for (let i = 0; i < stats.recoverySamples.length; i++) {
      const value = stats.recoverySamples[i];
      streak = Number.isFinite(value) && value <= baseline + slack ? streak + 1 : 0;
      if (streak >= need) return stats.sampleTimes[i];
    }
    return NaN;
  }
  function csv(result) {
    const keys = Object.keys(result);
    const cell = value => {
      let s = value == null ? "" : Array.isArray(value) ? value.join("; ") : String(value);
      // Spreadsheet labels must remain text, even when they start with a formula.
      if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    return keys.map(cell).join(",") + "\r\n" + keys.map(k => cell(result[k])).join(",") + "\r\n";
  }
  function readHistory(text) {
    try {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) return [];
      return rows.filter(r => r && r.version === 1 && typeof r.timestamp === "string" &&
        typeof r.label === "string" && r.label.length <= 80 &&
        typeof r.overall_grade === "string" &&
        Object.entries(r).every(([key, value]) => key === "quality_warnings"
          ? Array.isArray(value) && value.every(v => typeof v === "string")
          : value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))))
        .slice(-20);
    } catch (_) { return []; }
  }
  function calibrationStatus(speeds) {
    if (speeds.length < 2 || speeds.some(s => !Number.isFinite(s) || s <= 0)) return "unconfirmed";
    const previous = speeds[speeds.length - 2], last = speeds[speeds.length - 1];
    if (last > previous * 1.05) return "rising";
    if (last < previous * 0.8) return "unstable";
    return "plateau";
  }
  function saturationWarnings(status, measured, expected) {
    const warnings = [];
    if (status === "rising") warnings.push("Speed was still increasing during calibration.");
    else if (status === "unstable") warnings.push("Speed varied during calibration.");
    else if (status !== "plateau") warnings.push("Calibration did not reach a steady speed.");
    if (expected > 0 && measured < expected * 0.8) warnings.push("Measured speed was below 80% of your expected speed.");
    return warnings;
  }
  function summarize(runs) {
    const summary = {};
    const valid = runs.filter(r => ["A+", "A", "B", "C", "D", "F"].includes(r.overall_grade));
    for (const key of Object.keys(fields)) {
      if (key === "overall_grade") continue;
      const values = valid.map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
      if (!values.length) continue;
      const mid = Math.floor(values.length / 2);
      const median = values.length % 2 ? values[mid] : values[mid - 1] / 2 + values[mid] / 2;
      summary[key] = { count: values.length, median, min: values[0], max: values[values.length - 1], spread: values[values.length - 1] - values[0] };
    }
    return summary;
  }
  const api = { fields, quality, recovery, csv, readHistory, calibrationStatus, saturationWarnings, summarize };
  if (typeof module !== "undefined") module.exports = api;
  else globalThis.TestResults = api;
})();
