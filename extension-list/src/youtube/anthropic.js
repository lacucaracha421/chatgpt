// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
const { SPEAKER_INSTRUCTION } = globalThis.LakomicsYouTube.prompts;
const { requestBudget } = globalThis.LakomicsYouTube.deadline;
// Minimal Anthropic Messages API client using raw fetch (the extension has no bundler or dependencies).
const { buildChunkPrompt, buildGlossaryPrompt } = globalThis.LakomicsYouTube.prompts;
const { validateChunk, validateGlossary } = globalThis.LakomicsYouTube.results;

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 60000;

function buildRequestBody(args) {
  const { system, userText, schema } = buildChunkPrompt(args);
  return {
    model: args.model,
    thinking: { type: args.model === "claude-sonnet-5-5" ? "between_tools" : "disabled" },
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: userText }],
  };
}

function buildGlossaryBody(args) {
  const { system, userText, schema } = buildGlossaryPrompt(args);
  return {
    model: args.model, max_tokens: 4000,
    thinking: { type: args.model === "claude-sonnet-5-5" ? "between_tools" : "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: userText }],
  };
}

function apiError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const header = response.headers && response.headers.get ? response.headers.get("retry-after") : null;
  const seconds = header == null ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  return 1000 * 2 ** attempt;
}

async function httpError(response) {
  let detail = "";
  try {
    const body = await response.json();
    detail = (body && body.error && body.error.message) || "";
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // body was not JSON
  }
  const status = response.status;
  let message;
  if (status === 401 || status === 403) message = "API 키가 올바르지 않아요. 옵션에서 확인해 주세요.";
  else if (status === 429) message = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";
  else message = `API 오류가 났어요 (${status}). 잠시 후 다시 시도해 주세요.`;
  console.warn("[Lakomics YouTube] Anthropic API error", status, detail);
  return apiError(message, { status });
}

// Shared structured JSON transport; sleep is injectable for tests without real backoff.
async function requestJson({ apiKey, requestBody, sleep = defaultSleep, kind = "chunk", clock, budget = requestBudget(kind, clock) }) {
  const body = JSON.stringify(requestBody);
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };

  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await budget.run(async (signal) => {
        const response = await fetch(API_URL, { method: "POST", headers, body, signal, credentials: "omit", redirect: "error" });
        if (response.ok) return { data: await response.json() };
        return { response, failure: await httpError(response) };
      });
      if (result.data) { data = result.data; break; }
      const { response, failure } = result;
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        await budget.wait(retryDelayMs(response, attempt), sleep);
        continue;
      }
      throw failure;
    } catch (err) {
      if (err?.code !== "timeout" || attempt >= MAX_RETRIES || !budget.remaining()) throw err;
      await budget.wait(1000 * 2 ** attempt, sleep);
    }
  }

  const usage = { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 };
  if (data.stop_reason === "refusal") {
    throw apiError("모델이 이 자막의 처리를 거부했어요.", { code: "refusal", usage });
  }
  if (data.stop_reason === "max_tokens") {
    throw apiError("응답이 너무 길어서 잘렸어요.", { code: "max_tokens", usage });
  }

  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  if (!block) throw apiError("모델 응답에 텍스트가 없어요.", { usage });

  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    throw apiError("모델 응답을 읽을 수 없어요.", { usage });
  }
  return { parsed, usage };
}

// Returns lines, the reported register (null if invalid), and token usage.
async function callClaude({ apiKey, model, chunk, mode = "clean", register = null, context = [], speakers = false, glossary = [], meta = null, retryNote = "", sleep = defaultSleep, clock, budget }) {
  const { parsed, usage } = await requestJson({ apiKey, sleep, clock, budget,
    requestBody: buildRequestBody({ model, chunk, mode, register, context, speakers, glossary, meta, retryNote }) });
  return validateChunk(parsed, usage);
}

async function callGlossary({ apiKey, model, transcript, meta = null, userTerms = [], sleep = defaultSleep, clock, budget }) {
  const { parsed, usage } = await requestJson({ apiKey, sleep, clock, budget, kind: "glossary", requestBody: buildGlossaryBody({ model, transcript, meta, userTerms }) });
  return validateGlossary(parsed, usage);
}

(globalThis.LakomicsYouTube ??= {}).anthropic = { API_URL, API_VERSION, buildRequestBody, buildGlossaryBody, callClaude, callGlossary, SPEAKER_INSTRUCTION };
})();
