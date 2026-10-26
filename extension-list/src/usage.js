(() => {
  "use strict";
  // AI usage log: every call the extension pays for (X translation, right-click translation,
  // page translation, image text, YouTube subtitles) is recorded with its feature, model,
  // tokens and cost. One storage key holds per-day buckets (feature x counts), the last jobs
  // and, once, the YouTube total that existed before this log started.
  const KEY = "lakomics:usage:v1";
  const YOUTUBE_TOTAL = "lakomics:youtube:usage:total";
  const FEATURES = Object.freeze(["x", "context", "page", "image", "youtube"]);
  const FEATURE_LABELS = Object.freeze({ x: "X 번역", context: "우클릭 번역", page: "페이지 번역", image: "이미지 글자", youtube: "유튜브 자막" });
  const KEEP_DAYS = 400, MAX_JOBS = 50, MAX_PENDING = 2000;
  // Every storage.local write is delivered to every open tab, so writes are coalesced.
  // X calls often finish more than 1.5 seconds apart. A ten-second window groups
  // those calls too, while flushing before the worker's normal idle suspension.
  const FLUSH_DELAY_MS = 10000;

  // Anthropic list prices, verified 2026-10-13 (USD per 1M tokens). A model that is not listed,
  // or a token kind without a listed price (cache writes; cache reads on Haiku), has no cost.
  const PRICES = Object.freeze({
    // Haiku 5.5 bills a request whose input is above 100K tokens at the larger rates.
    "claude-haiku-5-5": Object.freeze({ input: 0.10, output: 0.50, largeAbove: 100000, largeInput: 0.50, largeOutput: 2.50 }),
    "claude-sonnet-5-5": Object.freeze({ input: 2.00, output: 10.00, cacheRead: 0.20 }),
    // Neuralwatt list prices, verified 2026-10-21 (USD per 1M tokens).
    "deepseek-v4-flash": Object.freeze({ input: 0.14, output: 0.28 }),
    "deepseek-v4.1-flash": Object.freeze({ input: 0.15, output: 0.60 }),
  });

  const count = value => Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const money = value => Math.round(value * 1e9) / 1e9;
  const modelId = model => String(model || "").replace(/^(anthropic|neuralwatt):/, "");
  const pad = value => String(value).padStart(2, "0");
  // The user's local calendar day, e.g. 2026-10-13.
  function localDay(ms = Date.now()) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // ------------------------------------------------------------------ price math
  // Cost in USD of one Anthropic response, or null when it cannot be priced.
  function anthropicCost(model, usage) {
    const price = PRICES[modelId(model)];
    if (!price || !usage || typeof usage !== "object") return null;
    const fresh = count(usage.input_tokens), written = count(usage.cache_creation_input_tokens), read = count(usage.cache_read_input_tokens), output = count(usage.output_tokens);
    if (written > 0) return null;
    if (read > 0 && price.cacheRead === undefined) return null;
    const large = price.largeAbove !== undefined && fresh + written + read > price.largeAbove;
    const rateIn = large ? price.largeInput : price.input, rateOut = large ? price.largeOutput : price.output;
    return money((fresh * rateIn + read * (price.cacheRead ?? 0) + output * rateOut) / 1e6);
  }
  // One response as {model, input, output, costUsd}; costUsd is null when unknown.
  // provider "anthropic": usage.input_tokens/output_tokens (+ cache tokens, counted as input).
  // provider "neuralwatt": usage.prompt_tokens/completion_tokens, priced from the table.
  // provider "openrouter": usage.prompt_tokens/completion_tokens and usage.cost (USD credits).
  function measure(provider, model, usage) {
    const id = (provider === "anthropic" || provider === "neuralwatt") ? modelId(model) : String(model || "");
    const body = usage && typeof usage === "object" ? usage : null;
    if (!body) return { model: id, input: 0, output: 0, costUsd: null };
    if (provider === "anthropic") {
      return { model: id, costUsd: anthropicCost(id, body), output: count(body.output_tokens),
        input: count(body.input_tokens) + count(body.cache_creation_input_tokens) + count(body.cache_read_input_tokens) };
    }
    if (provider === "neuralwatt") {
      const price = PRICES[id], input = count(body.prompt_tokens), output = count(body.completion_tokens);
      return { model: id, input, output, costUsd: price ? money((input * price.input + output * price.output) / 1e6) : null };
    }
    return { model: id, input: count(body.prompt_tokens), output: count(body.completion_tokens),
      costUsd: Number.isFinite(body.cost) && body.cost >= 0 ? money(body.cost) : null };
  }

  // ------------------------------------------------------------------ stored document
  const emptyCell = () => ({ requests: 0, input: 0, output: 0, costUsd: 0, unknownCostRequests: 0 });
  function cellFrom(value) {
    const cell = emptyCell();
    if (value && typeof value === "object") for (const field of Object.keys(cell)) cell[field] = Number.isFinite(value[field]) && value[field] > 0 ? value[field] : 0;
    return cell;
  }
  function addToCell(cell, call) {
    cell.requests += call.requests ?? 1; cell.input += call.input; cell.output += call.output;
    if (call.costUsd === null) cell.unknownCostRequests += call.requests ?? 1; else cell.costUsd = money(cell.costUsd + call.costUsd);
  }
  function mergeCells(into, other) {
    for (const field of Object.keys(into)) into[field] = field === "costUsd" ? money(into[field] + other[field]) : into[field] + other[field];
    return into;
  }
  function readDoc(stored) {
    const doc = stored && typeof stored === "object" ? stored : {};
    const days = {};
    if (doc.days && typeof doc.days === "object") {
      for (const [day, features] of Object.entries(doc.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !features || typeof features !== "object") continue;
        days[day] = {};
        for (const feature of FEATURES) if (features[feature]) days[day][feature] = cellFrom(features[feature]);
      }
    }
    const jobs = (Array.isArray(doc.jobs) ? doc.jobs : []).filter(job => job && typeof job.id === "string" && FEATURES.includes(job.feature)).slice(0, MAX_JOBS)
    .map(job => ({ id: job.id, feature: job.feature, label: typeof job.label === "string" ? job.label : "", at: Number.isFinite(job.at) ? job.at : 0,
      models: Array.isArray(job.models) ? job.models.filter(model => typeof model === "string") : [], requests: count(job.requests), input: count(job.input), output: count(job.output),
      costUsd: Number.isFinite(job.costUsd) && job.costUsd > 0 ? job.costUsd : 0, unknown: count(job.unknown) }));
    // undefined: the earlier YouTube total has not been folded in yet; null: there was none (or the log was cleared).
    const legacy = Object.hasOwn(doc, "legacy") ? (doc.legacy ? cellFrom(doc.legacy) : null) : undefined;
    return { v: 1, days, jobs, legacy };
  }
  function pruneDays(days, now) {
    const cutoff = localDay(now - KEEP_DAYS * 86400000);
    for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
  }
  // The YouTube running total kept before this log existed, as one cell (price table at the
  // normal rates; models without a price make the whole row "partly unknown").
  function legacyFrom(total) {
    if (!total || typeof total !== "object") return null;
    const cell = emptyCell();
    cell.requests = count(total.videos); cell.input = count(total.input_tokens); cell.output = count(total.output_tokens);
    let priced = true;
    for (const [model, tokens] of Object.entries(total.byModel && typeof total.byModel === "object" ? total.byModel : {})) {
      const cost = anthropicCost(model, { input_tokens: tokens?.input_tokens, output_tokens: tokens?.output_tokens });
      if (cost === null) priced = false; else cell.costUsd = money(cell.costUsd + cost);
    }
    if (!priced || !total.byModel) cell.unknownCostRequests = cell.requests;
    return cell.requests || cell.input || cell.output ? cell : null;
  }
  function applyCalls(doc, calls, now) {
    for (const call of calls) {
      const day = localDay(call.at), features = doc.days[day] ||= {};
      addToCell(features[call.feature] ||= emptyCell(), call);
      if (!call.job) continue;
      let job = doc.jobs.find(item => item.id === call.job.id);
      if (!job) job = { id: call.job.id, feature: call.feature, label: call.job.label, at: call.at, models: [], requests: 0, input: 0, output: 0, costUsd: 0, unknown: 0 };
      else doc.jobs.splice(doc.jobs.indexOf(job), 1);
      job.at = Math.max(job.at, call.at); job.requests += 1; job.input += call.input; job.output += call.output;
      if (call.costUsd === null) job.unknown += 1; else job.costUsd = money(job.costUsd + call.costUsd);
      if (call.model && !job.models.includes(call.model) && job.models.length < 6) job.models.push(call.model);
      doc.jobs.unshift(job);
    }
    doc.jobs.length = Math.min(doc.jobs.length, MAX_JOBS);
    pruneDays(doc.days, now);
    return doc;
  }

  // ------------------------------------------------------------------ recording (worker)
  const pending = [];
  let timer = null, chain = Promise.resolve();
  function validJob(job) {
    if (!job || typeof job !== "object" || typeof job.id !== "string" || !/^[\w:.-]{1,80}$/.test(job.id)) return null;
    return { id: job.id, label: typeof job.label === "string" ? job.label.replace(/\s+/g, " ").trim().slice(0, 120) : "" };
  }
  // Queues one call. measured is the result of measure(); job groups calls into one entry of the recent list.
  function record(feature, measured, job = null, at = Date.now()) {
    if (!FEATURES.includes(feature) || !measured) return;
    pending.push({ feature, at, model: String(measured.model || ""), input: count(measured.input), output: count(measured.output),
      costUsd: Number.isFinite(measured.costUsd) && measured.costUsd >= 0 ? measured.costUsd : null, job: validJob(job) });
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
    schedule();
  }
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_DELAY_MS);
  }
  // All reads and writes of the document go through one chain, so two jobs finishing together lose nothing.
  function serialized(work) {
    const result = chain.then(work);
    chain = result.catch(() => {});
    return result;
  }
  // Writes everything queued so far (and, the first time, folds in the earlier YouTube total).
  function flush() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    return serialized(async () => {
      const calls = pending.splice(0);
      try {
        const keys = [KEY, YOUTUBE_TOTAL], stored = await chrome.storage.local.get(keys);
        const doc = readDoc(stored[KEY]);
        if (!calls.length && doc.legacy !== undefined) return;
        if (doc.legacy === undefined) doc.legacy = legacyFrom(stored[YOUTUBE_TOTAL]);
        applyCalls(doc, calls, Date.now());
        await chrome.storage.local.set({ [KEY]: doc });
      } catch (error) {
        pending.unshift(...calls);
        if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
        schedule();
        throw error;
      }
    });
  }
  // The YouTube total must be folded in before anything adds to it.
  function ensureMigrated() { return flush(); }
  // Empties the log. The earlier YouTube total stays out of it afterwards.
  function clear() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    pending.length = 0;
    return serialized(async () => {
      pending.length = 0;
      await chrome.storage.local.set({ [KEY]: { v: 1, days: {}, jobs: [], legacy: null } });
    });
  }

  // ------------------------------------------------------------------ per-job tally (for a status line)
  const newTally = () => ({ requests: 0, input: 0, output: 0, costUsd: 0, unknown: 0 });
  function tallyAdd(tally, measured) {
    tally.requests += 1; tally.input += count(measured.input); tally.output += count(measured.output);
    if (Number.isFinite(measured.costUsd)) tally.costUsd = money(tally.costUsd + measured.costUsd); else tally.unknown += 1;
    return tally;
  }

  // ------------------------------------------------------------------ reading (options page)
  function summarize(stored, now = Date.now()) {
    const doc = readDoc(stored), today = localDay(now), month = today.slice(0, 7);
    const rows = {};
    for (const feature of FEATURES) rows[feature] = { today: emptyCell(), month: emptyCell(), total: emptyCell() };
    for (const [day, features] of Object.entries(doc.days)) {
      for (const feature of FEATURES) {
        const cell = features[feature]; if (!cell) continue;
        mergeCells(rows[feature].total, cell);
        if (day.startsWith(month)) mergeCells(rows[feature].month, cell);
        if (day === today) mergeCells(rows[feature].today, cell);
      }
    }
    const all = { today: emptyCell(), month: emptyCell(), total: emptyCell() };
    for (const feature of FEATURES) for (const span of Object.keys(all)) mergeCells(all[span], rows[feature][span]);
    if (doc.legacy) mergeCells(all.total, doc.legacy);
    return { rows, all, legacy: doc.legacy || null, jobs: doc.jobs };
  }
  function formatCost(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return "$0.0000";
    return usd < 0.0001 ? "<$0.0001" : "$" + usd.toFixed(4);
  }
  function formatTokens(value) {
    const n = count(value);
    if (n < 1000) return String(n);
    if (n < 100000) return (n / 1000).toFixed(1) + "k";
    if (n < 1000000) return Math.round(n / 1000) + "k";
    return (n / 1000000).toFixed(2) + "M";
  }
  // "$0.0123", "비용 모름" when nothing in the cell could be priced, or the cost plus "일부 모름".
  function describeCost(cell) {
    if (!cell || !cell.requests) return "-";
    if (cell.unknownCostRequests >= cell.requests) return "비용 모름";
    const text = formatCost(cell.costUsd);
    return cell.unknownCostRequests ? `${text} · 일부 모름` : text;
  }
  function describeTokens(cell) { return cell && cell.requests ? `입력 ${formatTokens(cell.input)} / 출력 ${formatTokens(cell.output)}` : ""; }

  globalThis.LakomicsUsage = { KEY, YOUTUBE_TOTAL, FEATURES, FEATURE_LABELS, PRICES, localDay, anthropicCost, measure, record, flush, ensureMigrated, clear,
    newTally, tallyAdd, summarize, formatCost, formatTokens, describeCost, describeTokens, applyCalls, readDoc, legacyFrom };
})();
