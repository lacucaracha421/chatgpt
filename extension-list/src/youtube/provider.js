(() => {
  "use strict";
  const { callClaude, callGlossary } = globalThis.LakomicsYouTube.anthropic;
  // Independent of X's queue, across all videos and glossary calls.
  let running = 0;
  const waiting = [];
  async function anthropic(provider, work, args) {
    if (provider !== "anthropic") throw new Error("Unsupported subtitle provider");
    if (running >= 8) await new Promise(resolve => waiting.push(resolve));
    else running++;
    try { return await work(args); }
    finally {
      if (waiting.length) waiting.shift()();
      else running--;
    }
  }
  globalThis.LakomicsYouTube.provider = {
    callChunk: (provider, args) => anthropic(provider, callClaude, args),
    callGlossaryFor: (provider, args) => anthropic(provider, callGlossary, args),
  };
})();
