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
