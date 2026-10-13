import { useFirstAppearance } from "../shared/motion/useFirstAppearance";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { Button } from "../shared/ui/Button";
import { SegmentedControl, type SegmentedOption } from "../shared/ui/SegmentedControl";
import { ShelfBridgeContext, ShelfScroller, type ShelfBridge } from "../shared/ui/ShelfScroller";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Toast } from "../shared/ui/Toast";
import { ShelfDrag, type ShelfDragHost } from "../shared/shelfDrag";
import { SHELF_MOVE_ITEMS as MOVE_ITEMS, SHELF_KEY_MOVES as KEY_MOVES, canMove, movedIds, orderAnnouncement, type OrderMove } from "../shared/shelfOrder";

type FolderReorder = {
  ids: string[];
  names: Record<string, string>;
  onReorder: (ids: string[]) => Promise<void>;
};

type FolderShelfProps = {
  appearanceKey?: string;
  /** False: the cards show at once, without the first-visit rise. */
  entrance?: boolean;
  label: string;
  cards: ReactNode[];
  accessory?: ReactNode;
  ariaLabel?: string;
  className?: string;
  labelClassName?: string;
  reorder?: FolderReorder;
};

export function FolderShelf({ label, cards, accessory, ariaLabel, className, labelClassName, appearanceKey = "classification-folder-shelf", entrance = true, reorder }: FolderShelfProps) {
  const host = useRef<HTMLElement>(null);
  useFirstAppearance(host, cards.length, entrance, appearanceKey, ".folder-shelf__card");
  const shelfClassName = ["folder-shelf", className].filter(Boolean).join(" ");
  const sectionLabelClassName = ["ui-section-label", "folder-shelf__label", labelClassName].filter(Boolean).join(" ");
  const labelRowClassName = ["folder-shelf__label-row", labelClassName].filter(Boolean).join(" ");
  return <section ref={host} className={shelfClassName} aria-label={ariaLabel ?? label}>
    <div className={labelRowClassName}>
      <h3 className={sectionLabelClassName} aria-label={label}>
        <span className="ui-section-label__title">{label}</span>
        <span className="ui-section-label__rule" aria-hidden="true" />
        {accessory !== undefined && <span className="ui-section-label__actions">{accessory}</span>}
      </h3>
    </div>
    {cards.length > 0 && (reorder
      ? <FolderShelfReorder reorder={reorder} cards={cards} />
      : <ShelfScroller previousLabel="이전 항목" nextLabel="다음 항목">{cards}</ShelfScroller>)}
  </section>;
}


function FolderShelfReorder({ reorder, cards }: { reorder: FolderReorder; cards: ReactNode[] }) {
  const root = useRef<HTMLDivElement>(null);
  const bridge = useRef<ShelfBridge>({ locked: false, track: null }).current;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<string | null>(null);
  async function apply(ids: string[]) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setRetry(null);
    try { await reorder.onReorder(ids); }
    catch { setRetry(ids); }
    finally { pending.current = false; setBusy(false); }
  }
  function move(id: string, direction: OrderMove) {
    const next = movedIds(reorder.ids, id, direction);
    if (!next || pending.current) return;
    pendingFocus.current = id;
    setAnnouncement(orderAnnouncement("folder", reorder.names[id], next.indexOf(id)));
    void apply(next);
  }
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const card = [...(root.current?.querySelectorAll<HTMLElement>("[data-order-id]") ?? [])].find(card => card.dataset.orderId === id);
    card?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const track = bridge.track;
    if (!card || !track) return;
    const box = card.getBoundingClientRect(), view = track.getBoundingClientRect();
    if (box.left < view.left) track.scrollLeft -= view.left - box.left + 8;
    else if (box.right > view.right) track.scrollLeft += box.right - view.right + 8;
  }, [reorder.ids.join(), busy]);
  const host: ShelfDragHost = {
    band: (kind, id) => kind === "folder" && !pending.current && reorder.ids.length > 1 && reorder.ids.includes(id) ? reorder.ids : null,
    canPutIn: false, canTakeOut: false,
    onLift: () => undefined, onOver: () => undefined,
    onEnd: intent => { if (intent?.type === "reorder") void apply(intent.ids); },
  };
  const latestHost = useRef(host);
  latestHost.current = host;
  useEffect(() => {
    if (!root.current) return;
    return new ShelfDrag(root.current, bridge, () => latestHost.current).attach();
  }, [bridge]);
  return <div ref={root} className="shelf-reorder-root" onKeyDown={event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = KEY_MOVES[event.key];
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-order-id]") : null;
    if (!direction || !card || !root.current?.contains(card)) return;
    event.preventDefault(); event.stopPropagation();
    move(card.dataset.orderId!, direction);
  }}>
    <ShelfBridgeContext.Provider value={bridge}>
      <ShelfScroller previousLabel="이전 항목" nextLabel="다음 항목">{cards.map((card, index) => {
        const id = reorder.ids[index];
        return <ContextMenu key={id} items={MOVE_ITEMS.map(item => ({
          id: item.move, label: item.label, shortcut: item.shortcut,
          disabled: busy || !canMove(reorder.ids, id, item.move), onSelect: () => move(id, item.move),
        }))}>{card as ReactElement}</ContextMenu>;
      })}</ShelfScroller>
    </ShelfBridgeContext.Provider>
    <span className="shelf-order-live" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {retry && <Toast tone="error" actionLabel="다시 시도" onAction={() => void apply(retry)} onDismiss={() => setRetry(null)}>순서를 바꾸지 못했습니다</Toast>}
  </div>;
}

export type FolderFilterOption<T extends string> = SegmentedOption<T>;

type FolderFilterControlProps<T extends string> = {
  label: string;
  options: readonly FolderFilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

export function FolderFilterControl<T extends string>({ label, options, value, onChange, className }: FolderFilterControlProps<T>) {
  return <div className={["folder-filter", className].filter(Boolean).join(" ")}>
    <SegmentedControl label={label} options={options} value={value} onChange={onChange} />
    <FolderFilterHelp />
  </div>;
}

/** The ⓘ explaining 미분류 and 전체; `inLabel` sizes it for the end of a section label (the 보기 범위 section). */
export function FolderFilterHelp({ inLabel = false }: { inLabel?: boolean }) {
  const [open, setOpen] = useState(false);
  return <AnchoredPanel
    open={open}
    onOpenChange={setOpen}
    title="미분류와 전체"
    trigger={inLabel
      ? <button type="button" className="ui-section-label__open" aria-label="미분류와 전체 설명"><InformationCircleIcon aria-hidden="true" /></button>
      : <Button size="icon" variant="ghost" aria-label="미분류와 전체 설명"><InformationCircleIcon aria-hidden="true" /></Button>}
  >
    <div className="folder-filter__explanation">
      <p><strong>미분류</strong>: 이 폴더에 바로 들어 있고 아직 캐릭터나 하위 폴더에 없는 이미지</p>
      <p><strong>전체</strong>: 캐릭터와 하위 폴더까지 모두</p>
    </div>
  </AnchoredPanel>;
}
