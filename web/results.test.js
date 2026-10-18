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
