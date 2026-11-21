(() => {
"use strict";
const { requestBudget } = globalThis.LakomicsYouTube.deadline;
const { buildChunkPrompt, buildGlossaryPrompt } = globalThis.LakomicsYouTube.prompts;
const { validateChunk, validateGlossary } = globalThis.LakomicsYouTube.results;

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 60000;
const SAFETY_SETTINGS = Object.freeze([
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
].map((category) => ({ category, threshold: "BLOCK_NONE" })));

function apiModel(model) {
  return String(model || "").replace(/^gemini:/, "");
}

function thinkingConfigFor(model) {
  const id = apiModel(model);
  if (id.startsWith("gemini-4-")) return { thinkingLevel: "low" };
  return id.startsWith("gemini-2.5-") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
}

function buildRequestBody(args) {
  const { system, userText, schema } = buildChunkPrompt(args);
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      thinkingConfig: thinkingConfigFor(args.model),
    },
  };
}

function buildGlossaryBody(args) {
  const { system, userText, schema } = buildGlossaryPrompt(args);
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      thinkingConfig: thinkingConfigFor(args.model),
    },
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
  let detail = "", code = "";
  try {
    const body = await response.json();
    detail = body?.error?.message || "";
    const reason = Array.isArray(body?.error?.details)
      ? body.error.details.find((item) => typeof item?.reason === "string")?.reason
      : "";
    code = reason || body?.error?.status || "";
  } catch (err) {
    if (err?.name === "AbortError") throw err;
  }
  const status = response.status;
  const badKey = status === 401 || status === 403 ||
    (status === 400 && (code === "API_KEY_INVALID" || /API_KEY_INVALID|api[ _-]?key/i.test(`${code} ${detail}`)));
  let message;
  if (badKey) message = "API 키가 올바르지 않아요. 옵션에서 확인해 주세요.";
  else if (status === 429) message = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";
  else message = `API 오류가 났어요 (${status}). 잠시 후 다시 시도해 주세요.`;
  console.warn("[Lakomics YouTube] Gemini API error", status, code, detail);
  return apiError(message, { status, code, detail });
}

function extractUsage(meta) {
  const input = Number.isFinite(meta?.promptTokenCount) ? meta.promptTokenCount : 0;
  const candidates = Number.isFinite(meta?.candidatesTokenCount) ? meta.candidatesTokenCount : 0;
  const thoughts = Number.isFinite(meta?.thoughtsTokenCount) ? meta.thoughtsTokenCount : 0;
  const cached = Number.isFinite(meta?.cachedContentTokenCount) ? meta.cachedContentTokenCount : 0;
  return { input_tokens: input, output_tokens: candidates + thoughts, ...(cached > 0 ? { cached_tokens: cached } : {}) };
}

async function requestJson({ apiKey, model, requestBody, sleep = defaultSleep, kind = "chunk", clock, budget = requestBudget(kind, clock) }) {
  const url = `${API_BASE}${encodeURIComponent(apiModel(model))}:generateContent`;
  const body = JSON.stringify(requestBody);
  const headers = {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
  };

  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await budget.run(async (signal) => {
        const response = await fetch(url, { method: "POST", headers, body, signal, credentials: "omit", redirect: "error" });
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

  const usage = extractUsage(data?.usageMetadata);
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const finishReason = candidate?.finishReason;
  if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finishReason) || data?.promptFeedback?.blockReason) {
    throw apiError("모델이 이 자막의 처리를 거부했어요.", { code: "refusal", usage });
  }
  if (finishReason === "MAX_TOKENS") {
    throw apiError("응답이 너무 길어서 잘렸어요.", { code: "max_tokens", usage });
  }

  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((part) => typeof part?.text === "string" && !part.thought).map((part) => part.text).join("");
  if (!text) throw apiError("모델 응답에 텍스트가 없어요.", { usage });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw apiError("모델 응답을 읽을 수 없어요.", { usage });
  }
  return { parsed, usage };
}

async function callGemini({ apiKey, model, chunk, mode = "clean", register = null, context = [], following = [], speakers = false, glossary = [], meta = null, retryNote = "", sleep = defaultSleep, clock, budget }) {
  const { parsed, usage } = await requestJson({ apiKey, model, sleep, clock, budget,
    requestBody: buildRequestBody({ model, chunk, mode, register, context, following, speakers, glossary, meta, retryNote }) });
  return validateChunk(parsed, usage);
}

async function callGlossary({ apiKey, model, transcript, meta = null, userTerms = [], sleep = defaultSleep, clock, budget }) {
  const { parsed, usage } = await requestJson({ apiKey, model, sleep, clock, budget, kind: "glossary",
    requestBody: buildGlossaryBody({ model, transcript, meta, userTerms }) });
  return validateGlossary(parsed, usage);
}

(globalThis.LakomicsYouTube ??= {}).gemini = { API_BASE, SAFETY_SETTINGS, buildRequestBody, buildGlossaryBody, callGemini, callGlossary };
})();
