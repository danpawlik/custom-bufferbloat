const test = require('node:test');
const assert = require('node:assert/strict');
const { quality, recovery, csv, readHistory } = require('./results.js');

test('grades require load in each direction and sufficient samples', () => {
  const good = { samples: [10, 10, 10, 10, 10], downBytes: 100, upBytes: 100, loadErrors: 0 };
  assert.deepEqual(quality(good, good, true, true), []);
  for (const bad of [{ ...good, downBytes: 0 }, { ...good, upBytes: 0 }, { ...good, loadErrors: 1 }, { ...good, samples: [10] }]) {
    assert.ok(quality(good, bad, true, true).length);
  }
  assert.ok(quality({ samples: [] }, good, true, false).length);
});

test('failed probes reset recovery streak', () => {
  const stats = { recoverySamples: [10, NaN, 10, NaN, 10], sampleTimes: [0, 200, 400, 600, 800] };
  assert.ok(Number.isNaN(recovery(stats, 10, 5, 3)));
  stats.recoverySamples.push(10, 10);
  stats.sampleTimes.push(1000, 1200);
  assert.equal(recovery(stats, 10, 5, 3), 1200);
});

test('CSV quotes labels and protects spreadsheet formulas', () => {
  const text = csv({ label: '=SUM(1,2)', note: 'a "quote"\nnext', recovery_ms: null });
  assert.ok(text.includes('"\'=SUM(1,2)"'));
  assert.ok(text.includes('"a ""quote""\nnext"'));
  assert.ok(text.endsWith(',""\r\n'));
});

test('history rejects corrupt data and retains the newest 20 runs', () => {
  assert.deepEqual(readHistory('broken'), []);
  assert.deepEqual(readHistory('{}'), []);
  const run = { version: 1, timestamp: '2026-10-18T00:00:00Z', label: '<script>text</script>', overall_grade: 'A+', recovery_ms: null, quality_warnings: [] };
  const rows = Array.from({ length: 25 }, (_, i) => ({ ...run, label: String(i) }));
  const parsed = readHistory(JSON.stringify(rows));
  assert.equal(parsed.length, 20);
  assert.equal(parsed[0].label, '5');
  assert.deepEqual(readHistory(JSON.stringify([{ ...run, quality_warnings: {} }, { ...run, download_mbps: {} }])), []);
  assert.equal(readHistory(JSON.stringify([run]))[0].label, run.label);
});

const { calibrationStatus, saturationWarnings, summarize } = require('./results.js');
test('calibration distinguishes plateau, rising, unstable and missing evidence', () => {
  for (const [speeds, status] of [
    [[], 'unconfirmed'], [[10], 'unconfirmed'], [[10, 12, 15], 'rising'],
    [[100, 105], 'plateau'], [[100, 80], 'plateau'], [[100, 79], 'unstable'],
    [[100, NaN, 100], 'unconfirmed'], [[0, 100], 'unconfirmed'], [[100, Infinity], 'unconfirmed'],
  ]) assert.equal(calibrationStatus(speeds), status);
  assert.equal(saturationWarnings('plateau', 80, 100).length, 0);
  assert.equal(saturationWarnings('plateau', 79.9, 100).length, 1);
  assert.equal(saturationWarnings('plateau', 1, 0).length, 0);
  assert.equal(saturationWarnings('rising', 50, 100).length, 2);
});

test('repeat summary uses finite values from valid runs, with a real even median', () => {
  const runs = [
    { overall_grade: 'A+', download_mbps: 30, recovery_ms: null },
    { overall_grade: 'A', download_mbps: 10, recovery_ms: 200 },
    { overall_grade: '—', download_mbps: 999, recovery_ms: 0 },
  ];
  const got = summarize(runs);
  assert.deepEqual(got.download_mbps, { count: 2, median: 20, min: 10, max: 30, spread: 20 });
  assert.equal(got.recovery_ms.count, 1);
  assert.equal(runs[0].download_mbps, 30);
  assert.deepEqual(summarize([{ overall_grade: '—', download_mbps: 10 }]), {});
});

test('repeat metadata and calibration survive history reload', () => {
  const run = { version: 1, timestamp: '2026-10-18T00:00:00Z', label: 'Repeat (1/3)', overall_grade: 'A',
    series_id: 'series1', run_index: 1, requested_runs: 3, download_calibration: 'plateau',
    upload_calibration: 'plateau', expected_download_mbps: 100, expected_upload_mbps: 20, quality_warnings: [] };
  assert.deepEqual(readHistory(JSON.stringify([run])), [run]);
});

test('calibration advisories remain separate from validity and repeat summaries', () => {
  const phase = { samples: [10, 10, 10, 10, 10], downBytes: 100, upBytes: 100, loadErrors: 0 };
  const advice = saturationWarnings('rising', 50, 100).join(' ');
  assert.ok(advice.includes('Speed was still increasing'));
  assert.ok(advice.includes('below 80%'));
  assert.ok(!advice.includes('withheld'));
  assert.deepEqual(quality(phase, phase, true, true), []);
  const run = { version: 1, timestamp: '2026-10-18T00:00:00Z', label: 'Advisory', overall_grade: 'A+',
    download_mbps: 50, download_advisory: advice, upload_advisory: advice, quality_warnings: [] };
  assert.deepEqual(readHistory(JSON.stringify([run])), [run]);
  assert.equal(summarize([run]).download_mbps.count, 1);
});

test('live rates use recent bytes and hold between fresh samples', () => {
  const { liveRate } = require('./results.js');
  const rate = liveRate(0);
  assert.ok(Number.isNaN(rate(25000000, 250)));
  assert.equal(rate(100000000, 1000), 800);
  assert.equal(rate(100000000, 1200), 800);
  assert.equal(rate(200000000, 2000), 800);
  assert.equal(rate(201250000, 3000), 10); // A real slowdown is not hidden by the phase average.
  assert.equal(rate(201250000, 4000), 0);
  assert.equal(rate(NaN, 5000), 0);
  assert.ok(Number.isNaN(rate(0, 5000))); // Counter reset starts a fresh interval.
  assert.equal(rate(100000000, 6000), 800);
  assert.ok(Number.isNaN(liveRate(6000)(0, 6000))); // New phase has no stale reading.
});

test('independent live counters handle delayed upload samples without fake dips', () => {
  const { liveRate } = require('./results.js');
  const down = liveRate(0), up = liveRate(0);
  assert.equal(down(100000000, 1000), 800);
  let upload = up(12500000, 1000);
  assert.equal(upload, 100);
  // Download updates cannot advance the upload clock between server polls.
  assert.equal(down(200000000, 2000) + upload, 900);
  upload = up(37500000, 3000);
  assert.equal(upload, 100);
  assert.equal(up(37500000, 4000), 0); // Fresh unchanged counter means a real stall.
});

test('smoothed RTT jitter matches the Go estimator and decays after a spike', () => {
  const { jitterMs } = require('./results.js');
  assert.ok(Number.isNaN(jitterMs([])));
  assert.ok(Number.isNaN(jitterMs([10])));
  assert.equal(jitterMs([10, 10, 10]), 0);
  assert.equal(jitterMs([10, 26]), 1);
  assert.equal(jitterMs([26, 10]), 1);
  assert.equal(jitterMs([10, 26, 26]), 0.9375);
  assert.equal(jitterMs([10, 12, 11, 15]), 0.41845703125);
});

test('jitter method survives history and export without relabeling legacy results', () => {
  const old = { version: 1, timestamp: '2026-10-18T00:00:00Z', label: 'old', overall_grade: 'A', download_jitter_ms: 2 };
  const current = { ...old, label: 'new', jitter_method: 'rtt-ewma-1/16', download_jitter_ms: 0.4 };
  const restored = readHistory(JSON.stringify([old, current]));
  assert.equal(restored[0].jitter_method, undefined);
  assert.equal(restored[1].jitter_method, 'rtt-ewma-1/16');
  assert.match(csv(restored[1]), /rtt-ewma-1\/16/);
});

test('grade helpers expose six distinct colors and margin to next grade', () => {
  const { gradeInfo, gradeColor, GRADE_COLORS } = require('./results.js');
  assert.equal(GRADE_COLORS['A+'], '#2ee6c5');
  assert.equal(GRADE_COLORS['A'], '#4ade80');
  assert.equal(gradeColor('A+'), '#2ee6c5');
  assert.equal(gradeColor('C'), '#fbbf24');
  assert.equal(gradeColor('F'), '#f87171');
  assert.equal(gradeColor('—'), '#334155');
  let info = gradeInfo(0);
  assert.equal(info.grade, 'A+');
  assert.equal(info.color, '#2ee6c5');
  assert.equal(info.nextGrade, 'A');
  assert.ok(Math.abs(info.marginMs - 5) < 1e-9);
  assert.equal(info.label, '5.0 ms before A');
  info = gradeInfo(4.9);
  assert.equal(info.grade, 'A+');
  assert.equal(info.nextGrade, 'A');
  assert.ok(Math.abs(info.marginMs - 0.1) < 1e-9);
  info = gradeInfo(5);
  assert.equal(info.grade, 'A');
  assert.equal(info.nextGrade, 'B');
  assert.ok(Math.abs(info.marginMs - 25) < 1e-9);
  info = gradeInfo(29);
  assert.equal(info.grade, 'A');
  assert.equal(info.nextGrade, 'B');
  info = gradeInfo(30);
  assert.equal(info.grade, 'B');
  assert.equal(info.nextGrade, 'C');
  info = gradeInfo(400);
  assert.equal(info.grade, 'F');
  assert.equal(info.nextGrade, null);
  assert.equal(info.marginMs, 0);
  assert.equal(info.label, '0.0 ms over D');
  info = gradeInfo(500);
  assert.equal(info.grade, 'F');
  assert.equal(info.marginMs, 100);
  assert.equal(info.label, '100.0 ms over D');
  info = gradeInfo(NaN);
  assert.equal(info.grade, '—');
  assert.equal(info.color, '#334155');
  assert.equal(info.nextGrade, null);
  assert.equal(info.marginMs, null);
  assert.equal(info.label, '—');
});

test('withheld grade handles Infinity and negative as incomplete', () => {
  const { gradeInfo } = require('./results.js');
  for (const v of [Infinity, -Infinity, -1, -0.1]) {
    const info = gradeInfo(v);
    assert.equal(info.grade, '—');
    assert.equal(info.marginMs, null);
    assert.equal(info.label, '—');
  }
  const finfo = gradeInfo(500);
  assert.equal(finfo.grade, 'F');
  assert.ok(finfo.marginMs > 0);
});
