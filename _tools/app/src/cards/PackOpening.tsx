import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../shared/ui/Button";
import { BoosterPack } from "./BoosterPack";
import { CardBack } from "./CardBack";
import { CardSequence, useCardReducedMotion } from "./motion";
import { printVariables } from "./printAssets";
import { RevealEffects } from "./RevealEffects";
import { TradingCard } from "./TradingCard";
import { cardTiers, revealOrder, type CardData, type PackCover } from "./types";
import { BusyLabel } from "../shared/ui/BusyLabel";

type Phase = "pack" | "opening" | "reveal" | "results";
const noCards: readonly CardData[] = [];
/** The keep step after the reveal: the player picks the cards that enter the album. */
export interface KeepActions {
  /** Sends the chosen server slots; may return the cards as the album now holds them (serials). */
  onKeep: (slots: number[]) => Promise<readonly CardData[] | void>;
  /** Leaves the pack undecided; it stays listed as waiting for a decision. */
  onLater: () => void;
}
export function PackOpening({ cards: suppliedCards = noCards, cover, onClose, loadDraw, initialResults = false, onAlbum, keep, undecided: suppliedUndecided = false }: {
  cards?: readonly CardData[]; cover: PackCover; onClose: () => void;
  loadDraw?: () => Promise<{ cards: readonly CardData[]; alreadyOpened: boolean; undecided?: boolean }>;
  initialResults?: boolean; onAlbum?: () => void;
  keep?: KeepActions; undecided?: boolean;
}) {
  const [loaded, setLoaded] = useState<readonly CardData[] | null>(null);
  const cards = loaded ?? suppliedCards;
  const [pending, setPending] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const request = useRef<Promise<void> | null>(null), committed = useRef(false), settled = useRef(false);
  const reduced = useCardReducedMotion();
  const [phase, setPhase] = useState<Phase>(initialResults ? "results" : "pack");
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set(initialResults ? cards.map(c => c.id) : []));
  const revealedRef = useRef(new Set(initialResults ? cards.map(c => c.id) : []));
  const [effects, setEffects] = useState<Set<string>>(() => new Set());
  const [cutin, setCutin] = useState<CardData | null>(null);
  const [revealingAll, setRevealingAll] = useState(false);
  const [bestWaiting, setBestWaiting] = useState(false);
  // Nothing is selected at first: the player lifts the cards they want to keep.
  const [undecided, setUndecided] = useState(suppliedUndecided);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false), [keepError, setKeepError] = useState(false);
  const stage = useRef<HTMLDivElement>(null), wrapper = useRef<HTMLDivElement>(null), stack = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null);
  const [burst, setBurst] = useState(false);
  const cutinRoot = useRef<HTMLDivElement>(null), cutinDim = useRef<HTMLDivElement>(null), cutinCard = useRef<HTMLDivElement>(null), cutinBanner = useRef<HTMLSpanElement>(null);
  const cutinActive = useRef<CardData | null>(null), cutinQueue = useRef<CardData[]>([]), cardsRef = useRef(cards);
  cardsRef.current = cards;
  const opening = useRef<CardSequence | null>(null), reveals = useRef<CardSequence | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true; reveals.current = new CardSequence(reduced);
    setRevealingAll(false);
    if (cards.length > 0 && revealedRef.current.size === cards.length) setPhase("results");
    return () => { mounted.current = false; opening.current?.stop(); reveals.current?.stop(); };
  }, [reduced, cards.length]);
  const showResults = (next: readonly CardData[]) => {
    revealedRef.current = new Set(next.map(card => card.id)); setRevealed(new Set(revealedRef.current)); setPhase("results");
  };
  const startRequest = () => {
    if (!loadDraw || request.current || settled.current) return;
    setError(false); setPending(true);
    request.current = loadDraw().then(result => {
      if (!mounted.current) return;
      setLoaded(result.cards); settled.current = true; setUndecided(result.undecided ?? true);
      if (result.alreadyOpened || reduced) showResults(result.cards);
      else if (committed.current) setPhase("opening");
    }).catch(() => {
      if (!mounted.current) return;
      committed.current = false; request.current = null; setError(true); setAttempt(value => value + 1);
    }).finally(() => { if (mounted.current) setPending(false); });
  };
  const tear = () => {
    committed.current = true;
    if (!loadDraw || settled.current) {
      if (reduced && loadDraw) showResults(cards); else setPhase("opening");
    } else startRequest();
  };
  /** One cut-in at a time; a second LR flipped meanwhile waits its turn. */
  const presentCutin = (card: CardData) => {
    if (cutinActive.current) { cutinQueue.current.push(card); return; }
    cutinActive.current = card; setCutin(card);
  };
  const advanceCutin = () => { const next = cutinQueue.current.shift() ?? null; cutinActive.current = next; setCutin(next); };
  const clearCutins = () => { cutinQueue.current = []; cutinActive.current = null; setCutin(null); };
  useEffect(() => { if (reduced) clearCutins(); }, [reduced]);
  /** LR cut-in as one awaited timeline: dim + travel to centre, then burst + punch, banner after the burst peak, hold, banner out, travel home + undim. */
  useLayoutEffect(() => {
    if (!cutin || reduced) return;
    const root = cutinRoot.current, dim = cutinDim.current, node = cutinCard.current, banner = cutinBanner.current;
    if (!root || !dim || !node || !banner) { advanceCutin(); return; }
    const index = cardsRef.current.findIndex(card => card.id === cutin.id);
    const slot = grid.current?.children[index] as HTMLElement | undefined;
    const slotCard = slot?.querySelector<HTMLElement>(".trading-card") ?? null;
    const size = node.getBoundingClientRect();
    const transformTo = (rect: DOMRect) => {
      const area = root.getBoundingClientRect();
      return `translate(${rect.left + rect.width / 2 - area.left - area.width / 2}px,${rect.top + rect.height / 2 - area.top - area.height / 2}px) scale(${rect.width / size.width})`;
    };
    const sequence = new CardSequence(false);
    const home = () => {
      const rect = slot?.getBoundingClientRect();
      return rect && rect.width && size.width ? transformTo(rect) : null;
    };
    setBurst(false);
    const start = home();
    // Before the first paint: the clone sits exactly on the slot card, which hides underneath it.
    if (start) node.style.transform = start;
    if (slotCard) slotCard.style.visibility = "hidden";
    const travel = (from: string, to: string, duration: number) => sequence.animate(node, [{ transform: from }, { transform: to }], duration);
    const run = async () => {
      await Promise.all([sequence.animate(dim, [{ opacity: 0 }, { opacity: 1 }], 200), start ? travel(start, "none", 500) : sequence.wait(0)]);
      if (sequence.stopped) return;
      flushSync(() => setBurst(true));
      await Promise.all([
        sequence.animate(node, [{ transform: "none" }, { transform: "scale(1.06)", offset: .4 }, { transform: "none" }], 260),
        sequence.wait(1200),
        (async () => { await sequence.wait(200); if (!sequence.stopped) await sequence.animate(banner, [{ transform: "translateX(-40%)", opacity: 0 }, { transform: "none", opacity: 1 }], 340); })(),
      ]);
      if (sequence.stopped) return;
      await sequence.animate(banner, [{ transform: "none", opacity: 1 }, { transform: "translateX(24%)", opacity: 0 }], 180);
      if (sequence.stopped) return;
      const back = home();
      await Promise.all([sequence.animate(dim, [{ opacity: 1 }, { opacity: 0 }], 300), back ? travel("none", back, 420) : sequence.wait(0)]);
      if (!sequence.stopped) advanceCutin();
    };
    void run();
    return () => { sequence.stop(); if (slotCard) slotCard.style.visibility = ""; };
  }, [cutin, reduced]);
  useEffect(() => {
    if (!cutin) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); clearCutins(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [cutin]);
  useEffect(() => {
    if (phase !== "opening") return;
    const sequence = new CardSequence(reduced); opening.current = sequence;
    const run = async () => {
      const pack = wrapper.current!, pile = stack.current!, slots = [...grid.current!.children] as HTMLElement[];
      const images = [...grid.current!.querySelectorAll("img")];
      const decoded = Promise.all(images.map(image => image.decode?.().catch(() => undefined)));
      await Promise.race([decoded, sequence.wait(1200)]);
      if (sequence.stopped) return;
      if (reduced) {
        await sequence.animate(pack, [{ opacity: 1 }, { opacity: 0 }], 180);
        if (sequence.stopped) return;
        pack.style.visibility = "hidden"; pile.style.visibility = "hidden"; grid.current!.style.visibility = "visible";
        await sequence.animate(grid.current!, [{ opacity: 0 }, { opacity: 1 }], 180);
      } else {
        await sequence.wait(360);
        if (sequence.stopped) return;
        const area = stage.current!.getBoundingClientRect(), pr = pack.getBoundingClientRect(), slot = slots[0]?.getBoundingClientRect();
        if (!slot) { setPhase("results"); return; }
        const w = slot.width, h = slot.height, scale = Math.min(1, pr.width * .84 / w), mouth = pr.top - area.top + pr.height * .054;
        const x = pr.left - area.left + pr.width / 2 - area.width / 2;
        const inside = `translate(${x}px, ${mouth + h * scale / 2 + 6 - area.height / 2}px) scale(${scale})`;
        const rise = `translate(${x}px, ${mouth - h * scale * .12 - area.height / 2}px) scale(${scale})`;
        Object.assign(pile.style, { width: `${w}px`, height: `${h}px`, left: `${(area.width - w) / 2}px`, top: `${(area.height - h) / 2}px`, transform: inside, visibility: "visible" });
        await sequence.animate(pile, [{ transform: inside }, { transform: rise }], 520);
        if (sequence.stopped) return;
        await Promise.all([
          sequence.animate(pack, [{ transform: "none", opacity: 1 }, { transform: "translateY(120px)", opacity: 0 }], 360),
          sequence.animate(pile, [{ transform: rise }, { transform: "translateY(-6px) scale(1.035)", offset: .72 }, { transform: "none" }], 460, 120),
        ]);
        if (sequence.stopped) return;
        pack.style.visibility = "hidden";
        const rect = pile.getBoundingClientRect();
        const plan = slots.map((slot, i) => {
          const r = slot.getBoundingClientRect(); const dx = rect.left + rect.width / 2 - r.left - r.width / 2, dy = rect.top + rect.height / 2 - r.top - r.height / 2;
          const transform = `translate(${dx}px,${dy}px)`; slot.style.transform = transform; slot.style.zIndex = String(slots.length - i); return { slot, dx, dy, transform };
        });
        grid.current!.style.visibility = "visible"; pile.style.visibility = "hidden";
        await Promise.all(plan.map(({ slot, dx, dy, transform }, i) => sequence.animate(slot, [{ transform }, { transform: `translate(${dx * .35}px,${dy * .35 - 18}px) rotate(${i % 2 ? 4 : -4}deg) scale(1.06)`, offset: .45 }, { transform: "none" }], 380, i * 120)));
        slots.forEach(slot => { slot.style.transform = ""; slot.style.zIndex = ""; });
      }
      if (!sequence.stopped && mounted.current) setPhase("reveal");
    };
    void run(); return () => sequence.stop();
  }, [phase, reduced]);
  /** Resolves when the slot card's flip transition ends (bounded by the CSS duration plus a margin). */
  const flipSettled = (sequence: CardSequence, id: string) => new Promise<void>(resolve => {
    const target = grid.current?.children[cards.findIndex(card => card.id === id)]?.querySelector(".card__flip");
    const done = () => { target?.removeEventListener("transitionend", onEnd); resolve(); };
    const onEnd = (event: Event) => { if (event.target === target && (event as TransitionEvent).propertyName === "transform") done(); };
    target?.addEventListener("transitionend", onEnd);
    void sequence.wait(480).then(done);
  });
  const flip = async (card: CardData) => {
    const sequence = reveals.current;
    if (!sequence || sequence.stopped || revealedRef.current.has(card.id)) return;
    revealedRef.current.add(card.id); setRevealed(new Set(revealedRef.current));
    if (card.tier === "lr" && !reduced) {
      // The LR burst belongs to the cut-in and plays only after the card has travelled to the centre.
      await flipSettled(sequence, card.id);
      if (sequence.stopped) return;
      presentCutin(card);
    } else {
      await sequence.wait(reduced ? 180 : 170);
      if (sequence.stopped) return;
      setEffects(previous => new Set(previous).add(card.id));
      await sequence.wait(reduced ? 0 : 570);
      if (sequence.stopped) return;
    }
    if (revealedRef.current.size === cards.length) setPhase("results");
  };
  const all = async () => {
    const sequence = reveals.current;
    if (revealingAll || !sequence || sequence.stopped) return;
    setRevealingAll(true);
    for (const id of revealOrder(cards, revealedRef.current)) {
      if (sequence.stopped) return;
      void flip(cards.find(card => card.id === id)!); await sequence.wait(reduced ? 60 : 200);
    }
    if (mounted.current && !sequence.stopped) { setRevealingAll(false); setBestWaiting(true); }
  };
  const skip = () => {
    opening.current?.stop(); reveals.current?.stop(); reveals.current = new CardSequence(reduced);
    revealedRef.current = new Set(cards.map(card => card.id)); setRevealed(new Set(revealedRef.current)); clearCutins(); setRevealingAll(false); setPhase("results");
  };
  const canReveal = phase === "reveal" && !revealingAll;
  const picking = !!keep && undecided && phase === "results";
  const toggle = (id: string) => {
    if (!picking || saving) return;
    setSelected(previous => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next; });
  };
  const saveSelection = async () => {
    if (!keep || saving || selected.size === 0) return;
    const slots = cards.flatMap((card, index) => selected.has(card.id) ? [card.slot ?? index] : []);
    setSaving(true); setKeepError(false);
    try {
      const next = await keep.onKeep(slots);
      if (!mounted.current) return;
      if (next) setLoaded(next);
      setSaved(new Set(selected)); setUndecided(false);
    } catch { if (mounted.current) setKeepError(true); }
    finally { if (mounted.current) setSaving(false); }
  };
  const inAlbum = (card: CardData) => !picking && phase === "results" && (!!card.kept || saved.has(card.id));
  const resultText = saved.size ? `앨범에 ${saved.size}장을 넣었습니다` : `공개 완료 · ${cards.length}장 · ${cards.filter(card => card.isNew).length}장 새로 발견`;
  return <div className="lkm-cards pack-opening" style={printVariables} data-phase={phase} data-reduced-motion={reduced}>
    <div className="pack-opening__toolbar"><span>오늘의 카드</span><div>{phase !== "pack" && phase !== "results" && <Button onClick={skip}>건너뛰기</Button>}{onAlbum && phase === "results" && <Button onClick={onAlbum}>앨범</Button>}<Button onClick={onClose}>닫기</Button></div></div>
    <div className="pack-opening__stage" ref={stage}>
      {(phase === "pack" || phase === "opening") && <div className="pack-opening__wrapper" ref={wrapper}><BoosterPack resetToken={attempt} cover={cover} cardCount={5} onTearStart={startRequest} onOpened={tear} disabled={phase === "opening" || (pending && committed.current)} /></div>}
      {phase === "opening" && <div className="pack-opening__stack" ref={stack}><i /><i /><CardBack /></div>}
      <div ref={grid} className="pack-opening__grid" style={{ visibility: phase === "pack" || phase === "opening" ? "hidden" : "visible" }}>
        {cards.map(card => <div className="pack-opening__slot" key={card.id} data-pickable={picking || undefined} data-selected={picking ? selected.has(card.id) : undefined}
          onClick={picking ? event => { if (!(event.target as HTMLElement).closest(".pack-opening__pick")) toggle(card.id); } : undefined}>
          <TradingCard card={card} faceDown={!revealed.has(card.id)} onReveal={canReveal ? () => { void flip(card); } : undefined} />
          {effects.has(card.id) && <RevealEffects tier={card.tier} reduced={reduced} />}
          {picking && <button type="button" role="checkbox" aria-checked={selected.has(card.id)} aria-label={`${card.tier.toUpperCase()} ${card.characterName} 선택`} className="pack-opening__pick" disabled={saving} onClick={() => toggle(card.id)}>
            <span className="pack-opening__box" aria-hidden="true" />{selected.has(card.id) && <span>선택됨</span>}
          </button>}
          {inAlbum(card) && <span className="pack-opening__pick pack-opening__pick--saved" data-checked="true"><span className="pack-opening__box" aria-hidden="true" />앨범에 넣음</span>}
        </div>)}
      </div>
      {cutin && <div className="cutin" key={cutin.id} ref={cutinRoot} role="button" tabIndex={0} aria-label="별빛 한정 연출 건너뛰기" onClick={clearCutins} onKeyDown={event => { if (["Enter", " ", "Escape"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); clearCutins(); } }}>
        <div className="cutin-dim" ref={cutinDim} style={{ opacity: 0 }} />
        <div className="cutin-card" ref={cutinCard}><TradingCard card={cutin} />{burst && <RevealEffects tier="lr" reduced={reduced} />}</div>
        <div className="cutin-banner"><span ref={cutinBanner} style={{ opacity: 0 }}><small>LR · 별빛 한정{cutin.serial ? ` · ${cutin.serial}` : ""}</small><b>{cutin.characterName}</b></span></div>
      </div>}
    </div>
    <div className="pack-opening__footer">{error && <p role="alert">팩을 열지 못했습니다. 다시 시도해 주세요.</p>}{keepError && <p role="alert">앨범에 넣지 못했습니다. 다시 시도해 주세요.</p>}<p role="status"><BusyLabel busy={pending || saving} delay={400} idle={phase === "pack" ? "윗 띠를 오른쪽으로 밀어서 뜯기 · Enter로 뜯기" : phase === "opening" ? "팩에서 카드를 꺼냅니다" : phase === "results" ? (picking ? `앨범에 넣을 카드를 눌러 고르세요 · ${resultText}` : resultText) : bestWaiting ? "마지막 한 장은 직접 뒤집어 보세요" : "카드를 눌러 뒤집기 · 모두 공개는 가장 좋은 카드 한 장을 남겨 둡니다"}>{saving ? "앨범에 넣는 중" : "팩을 여는 중"}</BusyLabel></p>
      {phase === "results" && <div className="pack-opening__results" aria-label="등급별 결과">{[...cardTiers].reverse().map(tier => { const count = cards.filter(card => card.tier === tier).length; return count ? <span key={tier}>{tier.toUpperCase()} {count}장</span> : null; })}</div>}
      {picking && <div className="pack-opening__keep"><Button variant="primary" disabled={selected.size === 0 || saving} onClick={() => { void saveSelection(); }}>{`앨범에 넣기 (${selected.size}장)`}</Button><Button disabled={saving} onClick={keep!.onLater}>나중에</Button></div>}
      {phase === "reveal" && cards.length - revealed.size > 1 && <Button disabled={revealingAll} onClick={() => { void all(); }}>모두 공개</Button>}
    </div>
  </div>;
}
