import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const load = name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const translationSources = await Promise.all([
  'translation/korean-rules.js',
  'translation/korean.js',
  'translation/terms.js',
  'translation/deadline.js',
  'translation/image.js',
  'usage.js',
  'translate-service.js',
].map(load));

const youtubeSources = await Promise.all([
  'translation/korean-rules.js',
  'translation/korean.js',
  'translation/terms.js',
  'translation/deadline.js',
  'translation/image.js',
  'usage.js',
  'translate-service.js',
  'youtube/settings.js',
  'youtube/terms.js',
  'youtube/korean.js',
  'youtube/deadline.js',
  'youtube/parse.js',
  'youtube/chunk.js',
  'youtube/order.js',
  'youtube/display.js',
  'youtube/cues.js',
  'youtube/timing.js',
  'youtube/resume.js',
  'youtube/mode.js',
  'youtube/prompts.js',
  'youtube/results.js',
  'youtube/anthropic.js',
  'youtube/gemini.js',
  'youtube/provider.js',
  'youtube/server-cache.js',
  'youtube/asr-choice.js',
  'youtube/source-pref.js',
  'youtube/service.js',
].map(load));

function makeStorage(initial = {}) {
  const memory = structuredClone(initial);
  return {
    memory,
    local: {
      async get(keys) {
        if (keys == null) return structuredClone(memory);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(k => Object.hasOwn(memory, k)).map(k => [k, structuredClone(memory[k])]));
      },
      async set(values) { Object.assign(memory, structuredClone(values)); },
      async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete memory[k]; },
    },
  };
}

function makeCacheStore() {
  const map = new Map();
  return {
    async read(index) { return map.get(index); },
    async write(entries) { for (const [i, v] of entries) map.set(i, v); },
    async clear() { map.clear(); },
  };
}

function createWorker(sources, { stored = {}, fetchImpl }) {
  const storage = makeStorage(stored);
  const requests = [];
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, console, crypto: globalThis.crypto,
    LakomicsTranslationCacheStore: makeCacheStore(),
    LakomicsListApi: { async readConnection() { return null; }, connectionIdentity() { return ''; } },
    chrome: {
      runtime: { id: 'ext-id', getURL: p => `chrome-extension://ext-id/${p}`, getPlatformInfo: cb => cb?.({}) },
      storage: { local: storage.local },
      tabs: { async sendMessage() {} },
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
      return fetchImpl(String(url), init, requests.length);
    },
  });
  context.globalThis = context;
  for (const src of sources) vm.runInContext(src, context);
  return { context, storage, requests };
}

const ownSender = { id: 'ext-id', url: 'chrome-extension://ext-id/options/options.html' };
const pageSender = { id: 'ext-id', tab: { id: 1 }, frameId: 0, url: 'https://example.com/' };

test('direct Google Gemini API handles X single, batch, context, page, image and usage accounting', async () => {
  const { context, requests } = createWorker(translationSources, {
    stored: {
      'lakomics:translation:storage-v4': true,
      'lakomics:translation:cache-indexeddb-v1': true,
      'lakomics:translation:v1': {
        enabled: true,
        geminiApiKey: 'AIza-test-key',
        model: 'gemini:gemini-3.1-flash-lite',
        fallbackModel: '',
        contextModel: 'gemini:gemini-4-hydrogen',
        imageModel: 'gemini:gemini-4-carbon',
      },
    },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.generationConfig?.responseJsonSchema?.properties?.translations) {
        const input = JSON.parse(body.contents[0].parts[0].text);
        const list = input.posts || input.items;
        return {
          ok: true, status: 200,
          async json() {
            return {
              candidates: [{
                finishReason: 'STOP',
                content: { parts: [
                  { thought: true, text: 'internal reasoning ignored' },
                  { text: JSON.stringify({ translations: list.map(i => ({ id: i.id, text: `번역:${i.text}` })) }) },
                ] },
              }],
              usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80, thoughtsTokenCount: 20, cachedContentTokenCount: 50 },
            };
          },
        };
      }
      if (body.generationConfig?.responseJsonSchema?.properties?.lines) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              candidates: [{
                finishReason: 'STOP',
                content: { parts: [{ text: JSON.stringify({ lines: [{ original: 'Hello', korean: '안녕', kind: 'dialogue', box: [100, 200, 300, 500] }] }) }] },
              }],
              usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40 },
            };
          },
        };
      }
      return {
        ok: true, status: 200,
        async json() {
          return {
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [{ thought: true, text: 'ignore me' }, { text: '안녕하세요!' }] },
            }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25 },
          };
        },
      };
    },
  });

  // 1. Settings expose hasGeminiKey and provider='gemini'
  const settings = await context.LakomicsTranslation.handle({ type: 'translation:settings' }, ownSender);
  assert.equal(settings.ok, true);
  assert.equal(settings.provider, 'gemini');
  assert.equal(settings.hasGeminiKey, true);
  assert.equal(settings.hasApiKey, true);
  assert.equal(settings.hasContextApiKey, true);
  assert.equal(settings.hasImageApiKey, true);

  // 2. X single request uses generativelanguage.googleapis.com, x-goog-api-key, thinkingLevel: minimal, filters thought parts
  const single = await context.LakomicsTranslation.handle({ type: 'translation:request', text: 'Hello world' }, pageSender);
  assert.equal(single.ok, true);
  assert.equal(single.text, '안녕하세요!');
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(requests[0].init.headers['x-goog-api-key'], 'AIza-test-key');
  assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.equal(requests[0].body.safetySettings.every(s => s.threshold === 'BLOCK_NONE'), true);

  // 3. X batch uses responseJsonSchema and filters thought parts
  const batch = await context.LakomicsTranslation.handle({ type: 'translation:request-batch', items: [{ id: '1', text: 'Good morning' }] }, pageSender);
  assert.equal(batch.ok, true);
  assert.equal(batch.items[0].text, '번역:Good morning');

  // 4. Right-click context uses gemini-4-hydrogen with thinkingLevel: low
  const ctx = await context.LakomicsTranslation.handle({ type: 'translation:context', kind: 'translate.ko.inline', text: 'Hi there' }, pageSender);
  assert.equal(ctx.ok, true);
  assert.equal(requests[2].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent');
  assert.deepEqual(requests[2].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });

  // 5. Image translation sends inlineData and parses Gemini [ymin, xmin, ymax, xmax] box schema on gemini-4-carbon
  context.LakomicsTranslationCore.image.fromDataUrl = () => ({ mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
  context.LakomicsTranslationCore.image.prepare = async () => ({ width: 800, height: 600, mediaType: 'image/png', base64: 'AAAA', pixels: null });
  context.LakomicsTranslationCore.image.paperSample = () => ({});
  const img = await context.LakomicsTranslation.handle({ type: 'translation:image', dataUrl: 'data:image/png;base64,AAAA' }, pageSender);
  assert.equal(img.ok, true);
  assert.equal(requests[3].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:generateContent');
  assert.deepEqual(requests[3].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.deepEqual(requests[3].body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  assert.deepEqual({ ...img.lines[0].box }, { x0: 200, y0: 100, x1: 500, y1: 300 });

  // 6. Usage measurement accounts for Gemini pricing including thoughts & cached tokens
  const measured = context.LakomicsUsage.measure('gemini', 'gemini:gemini-4-hydrogen', {
    promptTokenCount: 1_000_000, cachedContentTokenCount: 500_000, candidatesTokenCount: 500_000, thoughtsTokenCount: 500_000,
  });
  assert.equal(measured.model, 'gemini-4-hydrogen');
  assert.equal(measured.input, 1_000_000);
  assert.equal(measured.output, 1_000_000);
  // 0.5M * 1.50 + 0.5M * 0.075 + 1.0M * 7.50 = 0.75 + 0.0375 + 7.50 = 8.2875
  assert.equal(measured.costUsd, 8.2875);
});

test('direct Google Gemini API treats HTTP 400 API_KEY_INVALID as auth failure without retrying', async () => {
  const { context, requests } = createWorker(translationSources, {
    stored: {
      'lakomics:translation:storage-v4': true,
      'lakomics:translation:cache-indexeddb-v1': true,
      'lakomics:translation:v1': { enabled: true, geminiApiKey: 'bad-key', model: 'gemini:gemini-3.1-flash-lite', fallbackModel: '' },
    },
    fetchImpl: async () => ({
      ok: false, status: 400,
      async json() { return { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }; },
    }),
  });
  const res = await context.LakomicsTranslation.handle({ type: 'translation:request', text: 'Hello' }, pageSender);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'http_401');
  assert.equal(requests.length, 1);
});

test('YouTube subtitles run end-to-end on Google Gemini API with separate cache key and usage accounting', async () => {
  const ytSender = { id: 'ext-id', tab: { id: 2 }, frameId: 0, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
  const { context, requests } = createWorker(youtubeSources, {
    stored: {
      'lakomics:translation:storage-v4': true,
      'lakomics:translation:cache-indexeddb-v1': true,
      'lakomics:translation:v1': { geminiApiKey: 'AIza-yt-key' },
      'lakomics:youtube:settings:model': 'gemini:gemini-3.1-flash-lite',
    },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.generationConfig?.responseJsonSchema?.properties?.terms) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ register: 'haeyo', terms: [] }) }] } }],
              usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
            };
          },
        };
      }
      return {
        ok: true, status: 200,
        async json() {
          return {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ register: 'haeyo', lines: [{ from: 0, to: 1, text: '안녕 세상' }] }) }] } }],
            usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 10 },
          };
        },
      };
    },
  });

  const json3 = { events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello', tOffsetMs: 0 }, { utf8: ' world', tOffsetMs: 500 }] }] };
  const result = await context.LakomicsYouTubeService.handle({
    type: 'youtube:process', videoId: 'dQw4w9WgXcQ', trackKey: 'en:asr', json3, positionMs: 0,
  }, ytSender);
  assert.equal(result.ok, true);
  assert.equal(result.cues[0].text, '안녕 세상');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(requests[0].init.headers['x-goog-api-key'], 'AIza-yt-key');
  const storedMode = context.LakomicsYouTubeService.storedModeFor('en:asr', {
    translate: true, registerSetting: 'auto', speakers: false, glossarySonnet: true, model: 'gemini:gemini-3.1-flash-lite', dictionaryRevision: 0,
  });
  assert.match(storedMode, /\+gemini-3\.1-flash-lite/);
  assert.doesNotMatch(storedMode, /sonnet/);
});

test('options page exposes Google Gemini key card and links YouTube Gemini model to Gemini key', async () => {
  const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
  const sources = await Promise.all(['classification-tree', 'api-client', 'profile-store', 'arc-collector'].map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')));
  const optionsSource = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://extension.test/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  let hasGeminiKey = false;
  let ytModel = 'claude-haiku-5-5';
  const models = [
    { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini:gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (Google)' },
  ];
  w.chrome = { runtime: { async sendMessage(message) {
    if (message.type === 'settings:get') return { paired: false, state: null };
    if (message.type === 'translation:settings') return { ok: true, enabled: true, hasOpenRouterKey: true, hasGeminiKey, hasAnthropicKey: true, hasNeuralwattKey: false, hasApiKey: true, model: models[0].id, contextModel: '', imageModel: models[1].id, imageModels: models, models };
    if (message.type === 'translation:update') { if (message.geminiApiKey) hasGeminiKey = true; return { ok: true, enabled: true, hasOpenRouterKey: true, hasGeminiKey, hasAnthropicKey: true, hasNeuralwattKey: false, hasApiKey: true, model: models[0].id, contextModel: '', imageModel: models[1].id, imageModels: models, models }; }
    if (message.type === 'youtube:settings') return { ok: true, settings: { enabled: true, model: ytModel, translate: true, register: 'auto', speakers: false, glossarySonnet: false, fontScale: 1, position: 'default', showOriginal: false, rolling: false, localAsr: true, speakerColors: true } };
    if (message.type === 'youtube:update') { ytModel = message.patch.model ?? ytModel; return { ok: true, settings: { enabled: true, model: ytModel, translate: true, register: 'auto', speakers: false, glossarySonnet: false, fontScale: 1, position: 'default', showOriginal: false, rolling: false, localAsr: true, speakerColors: true } }; }
    return { ok: true };
  } } };
  for (const source of sources) w.eval(source);
  w.eval(optionsSource);
  await new Promise(r => setTimeout(r, 10));

  const ytSelect = w.document.querySelector('#youtube-model');
  ytSelect.value = 'gemini:gemini-3.1-flash-lite';
  ytSelect.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 10));
  assert.match(w.document.querySelector('#youtube-enabled-key-meta').textContent, /Google Gemini API 키 필요/);
  assert.equal(w.document.querySelector('#youtube-glossarySonnet').closest('.row').hidden, true);
  assert.match(w.document.querySelector('#translation-gemini-key-uses').textContent, /YouTube 자막/);

  const keyInput = w.document.querySelector('#translation-gemini-key');
  keyInput.value = 'AIza-demo';
  keyInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.querySelector('#translation-gemini-key-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(hasGeminiKey, true);
  assert.equal(w.document.querySelector('#translation-gemini-key-state').textContent, '✓ 저장됨');
  assert.match(w.document.querySelector('#youtube-model-key-meta').textContent, /Google Gemini 키/);
  dom.window.close();
});
