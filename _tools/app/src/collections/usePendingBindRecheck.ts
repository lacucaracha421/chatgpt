import { useCallback, useEffect, useRef, useState } from "react";

type Check = (background: boolean, isActive: () => boolean) => Promise<boolean>;

/** Replays one captured bind request until it leaves pending or the dialog closes. */
export function usePendingBindRecheck(open: boolean) {
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  const mounted = useRef(false);
  openRef.current = open;

  const cancel = useCallback(() => {
    generation.current++;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!open) cancel();
    return () => { mounted.current = false; cancel(); };
  }, [open, cancel]);

  async function run(check: Check) {
    if (!openRef.current || inFlight.current) return;
    cancel();
    const current = generation.current;
    const isActive = () => openRef.current && generation.current === current;
    let deadline: number | null = null;

    async function execute(background: boolean) {
      if (!isActive() || inFlight.current) return;
      if (background && deadline !== null && Date.now() >= deadline) return;
      inFlight.current = true;
      setRunning(true);
      let pending = false;
      try {
        pending = await check(background, isActive);
      } finally {
        inFlight.current = false;
        if (mounted.current) setRunning(false);
      }
      if (!pending || !isActive()) return;
      const delay = deadline === null ? 1_500 : 3_000;
      deadline ??= Date.now() + 120_000;
      if (Date.now() + delay >= deadline) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void execute(true);
      }, delay);
    }

    await execute(false);
  }

  return { running, run, cancel };
}
