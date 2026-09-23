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

test('a pairing the worker completed is shown as connected even if this page saw a failure', async () => {
  const previousChrome = globalThis.chrome, previousDocument = globalThis.document, previousLocation = globalThis.location, previousHistory = globalThis.history;
  const { JSDOM } = await import('../../_tools/app/node_modules/jsdom/lib/api.js');
  const dom = new JSDOM('<body></body>', { url: 'https://laku.example/extension-pair' });
  globalThis.document = dom.window.document; globalThis.location = dom.window.location; globalThis.history = dom.window.history;
  let pairedAt = 0;
  globalThis.chrome = { runtime: { lastError: null, sendMessage(message, callback) {
    if (message.type === 'pair') { pairedAt = Date.now(); setTimeout(() => callback({ ok: false, code: 'pairing_expired' }), 1); }
    else setTimeout(() => callback({ ok: true, paired: true, pairedAt }), 1);
  } } };
  try {
    const link = 'https://laku.example/extension-pair#' + 'A'.repeat(43);
    const result = await bridge.pairFromLocation(link);
    assert.equal(result.ok, true);
    assert.match(document.body.textContent, /연결됨/);
    // An older connection does not turn a real failure into success.
    pairedAt = 0;
    globalThis.chrome.runtime.sendMessage = (message, callback) => setTimeout(() => callback(message.type === 'pair' ? { ok: false, code: 'pairing_expired' } : { ok: true, paired: true, pairedAt: 1 }), 1);
    const failed = await bridge.pairFromLocation(link);
    assert.equal(failed.ok, false);
    assert.match(document.body.textContent, /만료됐거나 이미 사용/);
  } finally {
    globalThis.chrome = previousChrome; globalThis.document = previousDocument; globalThis.location = previousLocation; globalThis.history = previousHistory;
    dom.window.close();
  }
});
