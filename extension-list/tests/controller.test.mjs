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


test('collector save waits for the server contract instead of timing out at 15 seconds', () => {
  assert.equal(content.runtimeTimeoutMs({type:'collector:state'}), 15000);
  assert.equal(content.runtimeTimeoutMs({type:'collector:save',payload:{candidate:{type:'image'}}}), 70000);
  assert.equal(content.runtimeTimeoutMs({type:'collector:save',payload:{candidate:{type:'video'}}}), 310000);
});

test('save failures expose useful server reasons', () => {
  assert.equal(content.saveFailureMessage({code:'video_unavailable'}), 'X 영상을 찾을 수 없음');
  assert.equal(content.saveFailureMessage({code:'video_info_failed'}), 'X 영상 정보 조회 실패');
  assert.equal(content.saveFailureMessage({code:'server_save_failed',httpStatus:400,serverDetail:'Invalid source URL'}), '서버 거절 · 원문 URL 검증 실패');
  assert.equal(content.saveFailureMessage({code:'server_save_failed',httpStatus:400,serverDetail:'Unsupported content type: text/html'}), '서버 거절 · 원본 형식 text/html');
  assert.equal(content.saveFailureMessage({code:'server_save_failed',httpStatus:502,serverDetail:'Media returned HTTP 403'}), '서버 원본 수신 실패 · HTTP 403');
  assert.equal(content.saveFailureMessage({code:'timeout',httpStatus:0}), '서버 응답 시간 초과');
  assert.equal(content.saveFailureMessage({code:'offline',httpStatus:0}), '서버 연결 실패');
});


test('opening release click is consumed even when it lands inside the picker', () => {
  assert.equal(content.openingClickDisposition(true, true), 'consume');
  assert.equal(content.openingClickDisposition(false, true), 'picker');
  assert.equal(content.openingClickDisposition(false, false), 'page');
  assert.equal(content.TOUCH_LONG_PRESS_MS, 500);
  assert.equal(content.MOUSE_OPEN_DELAY_MS, 250);
});
