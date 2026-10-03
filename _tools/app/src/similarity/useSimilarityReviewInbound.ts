import { useWorkloadProfile } from "../app/workloadProfile";
import { isWindowFocused, subscribeWindowFocus, windowPollDelay } from "../app/windowFocus";
import { useEffect } from "react";
import type { LibraryGateway } from "../library/types";

/** Mobile similarity decisions were applied here: open reviews changed. */
export const SIMILARITY_REVIEW_CHANGED_EVENT = "lakomics-similarity-review-changed";

const POLL_MS = 10_000;

/**
 * Watch the cheap counter of mobile similarity decisions this PC applied (in the background
 * publication lane) and announce each change, so the review screen, its count and the trash
 * count reload. The first reading is only a baseline.
 */
export function useSimilarityReviewInbound(gateway: LibraryGateway, onChange: () => void) {
  const { restricted, hidden } = useWorkloadProfile();
  useEffect(() => {
    if (hidden) return;
    const read = gateway.similarityReviewInboundStatus?.bind(gateway);
    if (!read) return;
    let active = true;
    let running = false;
    let last: number | null = null;
    const poll = async () => {
      if (!active || running) return;
      running = true;
      try {
        const { applied } = await read();
        if (!active) return;
        if (last !== null && applied !== last) {
          window.dispatchEvent(new Event(SIMILARITY_REVIEW_CHANGED_EVENT));
          onChange();
        }
        last = applied;
      } catch {
        /* The next tick retries; nothing is lost. */
      } finally {
        running = false;
      }
    };
    void poll();
    let timer: number;
    const schedule = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => void poll(), windowPollDelay(restricted ? 60_000 : POLL_MS));
    };
    const unsubscribeFocus = subscribeWindowFocus(() => {
      if (isWindowFocused()) void poll();
      schedule();
    });
    schedule();
    return () => { active = false; window.clearInterval(timer); unsubscribeFocus(); };
  }, [gateway, onChange, restricted, hidden]);
}
