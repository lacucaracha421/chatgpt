(() => {
  "use strict";
  const core = globalThis.LakomicsTranslationCore ??= {};
  core.requestBudget = (totalMs, clock = {}) => {
    const now = clock.now || Date.now, schedule = clock.setTimeout || setTimeout, cancel = clock.clearTimeout || clearTimeout;
    const deadline = now() + totalMs;
    const timeout = () => Object.assign(new Error("Translation request timed out"), { code: "timeout", retryable: true });
    const remaining = () => Math.max(0, deadline - now());
    async function run(work, attemptMs, controller = new AbortController()) {
      const ms = Math.min(attemptMs, remaining());
      if (ms <= 0) { controller.abort(); throw timeout(); }
      let timer, onAbort;
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw timeout();
            return work(controller.signal);
          }),
          new Promise((_, reject) => {
            onAbort = () => reject(timeout());
            controller.signal.addEventListener("abort", onAbort, { once: true });
            timer = schedule(() => { controller.abort(); reject(timeout()); }, ms);
          }),
        ]);
      } catch (error) {
        if (error?.name === "AbortError") throw timeout();
        throw error;
      } finally {
        cancel(timer);
        controller.signal.removeEventListener("abort", onAbort);
      }
    }
    async function wait(ms, controller) {
      let sleeper;
      try { await run(() => new Promise(resolve => { sleeper = schedule(resolve, ms); }), remaining(), controller); }
      finally { cancel(sleeper); }
    }
    return { remaining, run, wait };
  };
})();
