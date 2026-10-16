import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, ExclamationTriangleIcon, InformationCircleIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import type { DirectReceive, ExchangeStore } from "./exchangeStore";

type Face = "blocked" | "public" | "failed" | "opened";

const LINES: Record<Face, string> = {
  blocked: "지금은 서버를 거쳐 받음",
  public: "공용 네트워크라 서버를 거쳐 받음",
  failed: "방화벽을 열지 못함",
  opened: "열림",
};
const HELP: Record<"blocked" | "public", string> = {
  blocked: "같은 Wi-Fi나 Tailscale의 태블릿이 이 PC로 바로 보내려면 Windows 방화벽에서 한 번 허용해야 합니다. 개인 네트워크에서만 열리고 관리자 확인 창이 뜹니다. 열지 않아도 파일은 서버를 거쳐 그대로 받습니다.",
  public: "이 Wi-Fi가 Windows에서 공용 네트워크로 되어 있어 직접 받을 수 없습니다. 설정 › 네트워크 및 인터넷에서 개인 네트워크로 바꾸면 직접 받습니다. 바꾸지 않아도 서버를 거쳐 받습니다.",
};

/** After a successful open the confirmation stays this long, then the block folds away. */
const OPENED_HOLD_MS = 1200;
/** Matches the 200 ms height collapse in exchange.css (plus the fade). */
const COLLAPSE_MS = 220;
/** Returning to the window re-checks (the user may have switched the network to Private) at most this often. */
const RECHECK_MS = 10_000;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * 직접 받기: the Windows firewall block of the 전송 index (PC only). It shows nothing unless direct receive
 * is blocked or the network is Public, and goes away once the firewall is open. See
 * docs/prototypes/transfer-route-20261016/README.md section 3.
 */
export function DirectReceiveBlock({ store, state, hasDevice }: { store: ExchangeStore; state: DirectReceive; hasDevice: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const clicked = useRef(false);
  // Set before the store learns "allowed", so that very render already shows the confirmation instead of folding away.
  const holding = useRef(false);

  const face: Face | null = opened || holding.current ? "opened"
    : !hasDevice ? null
    : state === "blocked" ? (failed ? "failed" : "blocked")
    : state === "public" ? "public"
    : null;

  // What stays on screen (and keeps its face while it folds away).
  const [kept, setKept] = useState<Face | null>(face);
  const [leaving, setLeaving] = useState(false);
  const [easeIn, setEaseIn] = useState(false);
  const started = useRef(true);
  useLayoutEffect(() => {
    const first = started.current;
    started.current = false;
    if (face) {
      if (kept === null && !first && !reducedMotion()) setEaseIn(true);
      setLeaving(false);
      setKept(face);
      return;
    }
    if (kept === null) return;
    if (reducedMotion()) { setKept(null); setEaseIn(false); return; }
    setLeaving(true);
    const timer = window.setTimeout(() => { setKept(null); setLeaving(false); setEaseIn(false); }, COLLAPSE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the target face only
  }, [face]);

  useEffect(() => {
    if (!opened) return;
    const timer = window.setTimeout(() => { holding.current = false; setOpened(false); }, OPENED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [opened]);

  const lastCheck = useRef(0);
  useEffect(() => {
    if (state !== "blocked" && state !== "public") return;
    const onFocus = () => {
      if (Date.now() - lastCheck.current < RECHECK_MS) return;
      lastCheck.current = Date.now();
      void store.checkDirectReceive();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [store, state]);

  async function open() {
    if (clicked.current) return;
    clicked.current = true;
    setBusy(true);
    setHelpOpen(false);
    try {
      const { outcome, state: next } = await store.openFirewall();
      if (outcome === "opened") { holding.current = true; setFailed(false); setOpened(true); }
      else setFailed(outcome === "failed");
      store.setDirectReceive(next);
    } catch {
      setFailed(true);
    } finally {
      clicked.current = false;
      setBusy(false);
    }
  }

  if (!kept) return null;
  const help = HELP[kept === "public" ? "public" : "blocked"];
  return <div className="exchange-direct-wrap" data-leaving={leaving ? "" : undefined}>
    <div className="exchange-direct-clip">
      <div className={`exchange-direct${easeIn ? " is-entering" : ""}${kept === "opened" ? " is-tint" : ""}`}>
        <div className="exchange-direct__head">
          <p className="exchange-index-label">직접 받기</p>
          {kept !== "opened" && <AnchoredPanel open={helpOpen} onOpenChange={setHelpOpen} title="직접 받기"
            trigger={<Button size="icon" variant="ghost" aria-label="직접 받기 도움말"><InformationCircleIcon aria-hidden="true" /></Button>}><p>{help}</p></AnchoredPanel>}
        </div>
        <p className={`exchange-direct__line${kept === "failed" ? " is-error" : kept === "opened" ? " is-done" : ""}`} role="status">
          {kept === "failed" && <ExclamationTriangleIcon aria-hidden="true" />}
          {kept === "opened" && <CheckIcon aria-hidden="true" />}
          {LINES[kept]}
        </p>
        {(kept === "blocked" || kept === "failed") && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void open()}>
          <ShieldCheckIcon aria-hidden="true" />
          <BusyLabel busy={busy} idle={kept === "failed" ? "다시 시도" : "방화벽 열기"}>여는 중</BusyLabel>
        </Button>}
      </div>
    </div>
  </div>;
}
