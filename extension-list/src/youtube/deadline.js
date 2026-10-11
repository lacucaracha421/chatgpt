(() => {
  "use strict";
  (globalThis.LakomicsYouTube ??= {}).deadline = {
    requestBudget(kind = "chunk", clock = {}) {
      const budget = globalThis.LakomicsTranslationCore.requestBudget(kind === "glossary" ? 30000 : 150000, clock);
      const localized = async work => {
        try { return await work(); }
        catch (error) {
          if (error?.code === "timeout") error.message = "요청 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.";
          throw error;
        }
      };
      return {
        remaining: budget.remaining,
        run: work => localized(() => budget.run(work, kind === "glossary" ? 25000 : 90000)),
        wait: (ms, sleep) => localized(() => budget.run(() => sleep(ms), budget.remaining())),
      };
    },
  };
})();
