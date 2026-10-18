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
