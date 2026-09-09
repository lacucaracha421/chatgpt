import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.__LAKOMICS_TEST__ = true;
await import('../src/content.js');
const content = globalThis.LakomicsListContent;

test('first invocation owns the opening state and duplicate pointer activation is rejected', () => {
  const gate = content.createInvocationGate();
  assert.equal(gate.arm(7), true);
  assert.equal(gate.arm(8), false);
  assert.equal(gate.opening(7), true);
  assert.equal(gate.opening(7), false);
  assert.equal(gate.opened(7), true);
  assert.equal(gate.phase, 'list-open');
  gate.close();
  assert.equal(gate.arm(8), true);
});

test('temporary intent accepts GIF-like images but not video', () => {
  const gif = content.temporaryIntent({type:'image',mediaUrl:'https://example.com/a.gif'});
  assert.match(gif, /^intent:\/\/temporary\?/);
  assert.equal(content.temporaryIntent({type:'video',mediaUrl:'https://example.com/a.mp4'}), null);
});


test('touch-owned long press suppresses native Android context UI', () => {
  assert.equal(content.shouldSuppressNativeContext({input:'touch'}, 'armed'), true);
  assert.equal(content.shouldSuppressNativeContext({input:'touch',longPressed:true}, 'opening'), true);
  assert.equal(content.shouldSuppressNativeContext({input:'mouse'}, 'idle'), false);
});

test('save result text reports real server ingestion state', () => {
  assert.equal(content.saveResultMessage({ok:true,status:'captured',captureStatus:'pending'}), '서버 저장됨 · PC 수신 대기');
  assert.equal(content.saveResultMessage({ok:true,status:'duplicate',captureStatus:'imported'}), '서버에 이미 있음 · PC 반영 완료');
  assert.equal(content.saveResultMessage({ok:true,status:'confirmed',captureStatus:'pending'}), '서버 저장 확인됨 · PC 수신 대기');
});
