(() => {
  "use strict";
  const { callClaude, callGlossary } = globalThis.LakomicsYouTube.anthropic;
  const gemini = globalThis.LakomicsYouTube.gemini;
  // Independent of X's queue, across all videos and glossary calls.
  let running = 0;
  const waiting = [];
  async function run(provider, kind, args) {
    let work;
    if (provider === "anthropic") work = kind === "chunk" ? callClaude : callGlossary;
    else if (provider === "gemini" && gemini) work = kind === "chunk" ? gemini.callGemini : gemini.callGlossary;
    else throw new Error("Unsupported subtitle provider");
    if (running >= 8) await new Promise(resolve => waiting.push(resolve));
    else running++;
    try { return await work(args); }
    finally {
      if (waiting.length) waiting.shift()();
      else running--;
    }
  }
  globalThis.LakomicsYouTube.provider = {
    callChunk: (provider, args) => run(provider, "chunk", args),
    callGlossaryFor: (provider, args) => run(provider, "glossary", args),
  };
})();
