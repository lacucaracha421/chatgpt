import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.__LAKOMICS_TEST__ = true;
await import('../src/pairing-bridge.js');
const bridge = globalThis.LakomicsPairingBridge;

test('pairing bridge accepts only HTTPS pairing fragments', () => {
  assert.equal(bridge.pairingLocation('https://laku.example/extension-pair#' + 'A'.repeat(43)), true);
  assert.equal(bridge.pairingLocation('https://laku.example/extension-pair'), false);
  assert.equal(bridge.pairingLocation('https://laku.example/other#' + 'A'.repeat(43)), false);
  assert.equal(bridge.pairingLocation('http://laku.example/extension-pair#' + 'A'.repeat(43)), false);
});

test('callback response wins over an early undefined Promise from Chromium/Titanium', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        setTimeout(() => callback({ ok: true, state: { ready: true } }), 5);
        return Promise.resolve(undefined);
      },
    },
  };
  try {
    const response = await bridge.runtimeMessage({ type: 'pair' });
    assert.equal(response.ok, true);
    assert.equal(response.state.ready, true);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('the failure page names the cause without exposing server details', () => {
  assert.match(bridge.failureReason({ code: 'pairing_expired' }), /만료됐거나 이미 사용/);
  assert.match(bridge.failureReason({ code: 'offline' }), /서버에 연결하지 못했습니다/);
  assert.match(bridge.failureReason({ code: 'worker_failed' }), /확장 프로그램이 응답하지 않습니다/);
  assert.match(bridge.failureReason({ code: 'pairing_failed', httpStatus: 500 }), /\(HTTP 500\)/);
  assert.match(bridge.failureReason(undefined), /알 수 없는 오류/);
});

test('visiting a web pairing link requests review without pairing or trusting a recent connection', async () => {
  const previous = { chrome: globalThis.chrome, document: globalThis.document, location: globalThis.location, history: globalThis.history };
  const { JSDOM } = await import('../../_tools/app/node_modules/jsdom/lib/api.js');
  const dom = new JSDOM('<body></body>', { url: 'https://laku.example/extension-pair#' + 'A'.repeat(43) });
  Object.assign(globalThis, { document: dom.window.document, location: dom.window.location, history: dom.window.history });
  const messages = [];
  globalThis.chrome = { runtime: { sendMessage(message, callback) { messages.push(message); callback({ ok: true, pending: true }); } } };
  try {
    const result = await bridge.pairFromLocation();
    assert.equal(result.pending, true);
    assert.deepEqual(messages.map(m => m.type), ['pair:review']);
    assert.equal(location.hash, '');
    assert.doesNotMatch(document.body.textContent, /연결됨/);
  } finally { Object.assign(globalThis, previous); dom.window.close(); }
});
