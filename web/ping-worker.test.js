const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function worker() {
  let aborted = 0;
  const messages = [];
  const context = {
    self: { postMessage: message => messages.push(message) },
    performance, AbortController, setTimeout, clearTimeout,
    fetch: (_, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
    }),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname + '/ping-worker.js', 'utf8'), context);
  return { context, messages, aborted: () => aborted };
}

test('worker deadline aborts actual fetch and frees pending request', async () => {
  const w = worker();
  await w.context.self.onmessage({ data: { id: 1, url: '/ping', timeoutMs: 10 } });
  assert.equal(w.aborted(), 1);
  assert.equal(w.messages[0].ok, false);
  assert.equal(vm.runInContext('pending.size', w.context), 0);
});

test('phase cancellation aborts a worker request immediately', async () => {
  const w = worker();
  const pending = w.context.self.onmessage({ data: { id: 1, url: '/ping', timeoutMs: 5000 } });
  await w.context.self.onmessage({ data: { id: 1, cancel: true } });
  await pending;
  assert.equal(w.aborted(), 1);
  assert.equal(vm.runInContext('pending.size', w.context), 0);
});
