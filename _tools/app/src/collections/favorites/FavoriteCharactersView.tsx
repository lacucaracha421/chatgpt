import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowLeftIcon, EllipsisHorizontalIcon, PencilIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { CharacterTarget } from "../../characters/api";
import type { CharacterBrowsePage } from "../../characters/hubApi";
import type { AssetView, CollectionSummary, FavoriteSet } from "../../library/types";
import { commandErrorMessage } from "../../library/errorMessage";
import { ViewToolbar } from "../../layout/ViewToolbar";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Menu } from "../../shared/ui/Menu";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Toast } from "../../shared/ui/Toast";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { useSectionDrop } from "../../shared/ui/useSectionDrop";
import { useBackHandler } from "../../shared/navigation/BackNavigation";
import { movedIds, type OrderMove } from "../../shared/shelfOrder";
import { VIEW_HERO_ATTRIBUTE } from "../../shared/motion/AreaSwitch";
import { reducedMotion } from "../../shared/motion/curves";
import { startViewSwap, viewTransitionRunning, type ViewSwap } from "../../shared/motion/viewSwap";
import { waitForViewportImages } from "../../shared/motion/viewportImages";
import { containerId, createFavoriteCommand, favoriteScopes, favoriteTargets, isManualFavorite, linkFavoriteCommand, reorderCommand } from "./model";
import { browseFavoriteAssets, type FavoriteCatalog } from "./useFavoriteCatalog";
import type { useFavoriteCharacters } from "./useFavoriteCharacters";
import { FavoriteAddPicker } from "./FavoriteAddPicker";
import { FavoriteCoverDialog } from "./FavoriteCoverDialog";
import { FavoriteDetail } from "./FavoriteDetail";
import { FavoriteGrid } from "./FavoriteGrid";
import "./favorites.css";

// Reopening a linked work returns to the same character and loaded asset page.
export const favoritePlaces = new Map<string, { open: boolean; scope: string; detail: { id: string; page: CharacterBrowsePage } | null; scrollTop: number; gridScrollTop?: number }>();

export function FavoriteCharactersView({ root, state, catalog, catalogError, collections, shortcuts, onBack, onNavigate, onWork, onRefreshCatalog }: {
  root: string; state: ReturnType<typeof useFavoriteCharacters>; catalog: FavoriteCatalog | null; catalogError: string | null;
  collections: CollectionSummary[]; shortcuts: ReactNode; onBack(): void; onNavigate(view: AssetView): void; onWork(work: CollectionSummary): void; onRefreshCatalog(): void;
}) {
  const place = favoritePlaces.get(root);
  const entries = state.document?.entries ?? [];
  const [scope, setScope] = useState(place?.scope ?? "all");
  const [storedDetail, setDetail] = useState(place?.detail ?? null);
  const [pendingDetail, setPendingDetail] = useState<typeof storedDetail>(null);
  const [linkDestination, setLinkDestination] = useState<{ from: string; id: string; page: CharacterBrowsePage } | null>(null);
  // The server reply can replace the id before change() resolves. Keep the detail visible throughout that swap.
  const detail = storedDetail && linkDestination?.from === storedDetail.id && entries.some(entry => entry.characterId === linkDestination.id) ? linkDestination : storedDetail;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [cover, setCover] = useState<{ id: string; page: CharacterBrowsePage } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const request = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const transition = useRef<ViewSwap | null>(null);
  const clearHero = useRef<(() => void) | undefined>(undefined);
  const stopPreparing = useRef<(() => void) | undefined>(undefined);
  const gridScroll = useRef(place?.gridScrollTop ?? (place?.detail ? 0 : place?.scrollTop ?? 0));
  const shownDetail = useRef(detail?.id);
  const displayedDetail = detail ?? pendingDetail;
  const showingDetail = !!(detail && entries.some(item => item.characterId === detail.id));
  const hero = (host: HTMLElement | null, id?: string) => {
    const card = id ? Array.from(host?.querySelectorAll<HTMLElement>("[data-favorite-card]") ?? []).find(card => card.dataset.favoriteCard === id) : host;
    const image = card?.querySelector<HTMLElement>(".favorite-portrait-image") ?? null;
    return image?.querySelector("img") ? image : null;
  };
  const onScreen = (element: HTMLElement | null, host: HTMLElement | null) => {
    const rect = element?.getBoundingClientRect(), clip = host?.getBoundingClientRect();
    return !!rect && !!clip && rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, clip.top)
      && rect.top < Math.min(window.innerHeight, clip.bottom) && rect.right > Math.max(0, clip.left) && rect.left < Math.min(window.innerWidth, clip.right);
  };
  const swapDetail = (next: typeof storedDetail) => {
    transition.current?.cancel();
    clearHero.current?.();
    transition.current = null;
    const oldHero = detail ? hero(detailRef.current) : hero(gridRef.current, next?.id);
    const newHero = next ? hero(detailRef.current) : hero(gridRef.current, detail?.id);
    const shared = onScreen(oldHero, detail ? detailRef.current : gridRef.current) && onScreen(newHero, next ? detailRef.current : gridRef.current);
    const commit = () => { oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE); setDetail(next); setPendingDetail(null); setEditing(false); };
    if (reducedMotion() || viewTransitionRunning()) { flushSync(commit); return; }
    if (shared) oldHero?.setAttribute(VIEW_HERO_ATTRIBUTE, "");
    const swap = startViewSwap({ attribute: "data-area-view-transition", value: shared ? "hero" : "", commit: () => {
      commit();
      if (shared) newHero?.setAttribute(VIEW_HERO_ATTRIBUTE, "");
    } });
    if (!swap) { oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE); flushSync(commit); return; }
    transition.current = swap;
    clearHero.current = () => { oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE); newHero?.removeAttribute(VIEW_HERO_ATTRIBUTE); };
    void swap.finished.then(() => {
      if (transition.current === swap) { clearHero.current?.(); clearHero.current = undefined; transition.current = null; }
    });
  };
  useLayoutEffect(() => {
    if (!pendingDetail || !detailRef.current) return;
    detailRef.current.scrollTop = 0;
    const token = request.current;
    stopPreparing.current = waitForViewportImages(detailRef.current, () => {
      // The readiness helper may finish synchronously during this layout effect.
      queueMicrotask(() => { if (request.current === token) { swapDetail(pendingDetail); setOpening(false); } });
    });
    return () => { stopPreparing.current?.(); stopPreparing.current = undefined; };
  }, [pendingDetail]);
  useLayoutEffect(() => {
    const scroller = detail ? detailRef.current : gridRef.current;
    if (!scroller || shownDetail.current === detail?.id) return;
    if (detail) scroller.scrollTop = 0;
    else scroller.scrollTop = gridScroll.current;
    shownDetail.current = detail?.id;
  }, [detail?.id]);
  const targets = favoriteTargets(entries, catalog?.targets ?? []);
  const scopes = favoriteScopes(targets, catalog?.classifications ?? []);
  const effectiveScope = scopes.some(option => option.value === scope) ? scope : "all";
  const visible = targets.filter(target => effectiveScope === "all" || containerId(target, catalog!.classifications) === effectiveScope);
  const target = targets.find(item => item.id === detail?.id);
  const entry = entries.find(item => item.characterId === detail?.id);
  const detailTarget = targets.find(item => item.id === displayedDetail?.id);
  const detailEntry = entries.find(item => item.characterId === displayedDetail?.id);
  const current = useRef({ scope, detail }); current.current = { scope, detail };
  useEffect(() => {
    // Keep DOM references for cleanup: React detaches refs before passive unmount effects.
    const gridScroller = gridRef.current, detailScroller = detailRef.current;
    if (gridScroller) gridScroller.scrollTop = gridScroll.current;
    const scroller = place?.detail ? detailScroller : gridScroller;
    if (scroller) scroller.scrollTop = favoritePlaces.get(root)?.scrollTop ?? 0;
    return () => {
      request.current++;
      stopPreparing.current?.(); transition.current?.cancel(); clearHero.current?.();
      if (favoritePlaces.get(root)?.open !== false) favoritePlaces.set(root, { open: true, ...current.current, scrollTop: (current.current.detail ? detailScroller : gridScroller)?.scrollTop ?? 0, gridScrollTop: gridScroller?.scrollTop ?? 0 });
    };
  }, [root]);
  const back = () => {
    request.current++; setOpening(false); setLinking(false);
    stopPreparing.current?.(); setPendingDetail(null);
    if (pendingDetail && !detail) { transition.current?.cancel(); clearHero.current?.(); return; }
    if (editing) { setEditing(false); return; }
    if (detail) { if (gridRef.current) gridRef.current.scrollTop = gridScroll.current; swapDetail(null); return; }
    onBack();
  };
  useBackHandler(back, 20, true);
  const change = async (commands: Parameters<typeof state.change>[0]) => {
    const saved = await state.change(commands);
    if (!saved && !commands.some(command => command.op === "link")) setRetry(() => () => { void change(commands); });
    else setRetry(null);
    return saved;
  };
  const link = async (id: string) => {
    if (!target || entries.some(item => item.characterId === id)) return false;
    const chosen = catalog?.targets.find(item => item.id === id);
    if (!chosen) return false;
    const token = ++request.current; setOpening(true);
    try {
      const page = await browseFavoriteAssets(chosen);
      if (request.current !== token) return false;
      setLinkDestination({ from: target.id, id, page });
      const saved = await change([linkFavoriteCommand(target.id, id)]);
      if (request.current !== token) return saved;
      if (saved) { setDetail({ id, page }); setEditing(false); }
      setLinkDestination(null);
      return saved;
    } catch (reason) { setError(commandErrorMessage(reason, "에셋 캐릭터와 연결하지 못했습니다.")); return false; }
    finally { if (request.current === token) setOpening(false); }
  };
  const save = (set: FavoriteSet) => change([{ op: "update", id: target!.id, set }]);
  const openPage = async (chosen: CharacterTarget, kind: "detail" | "cover") => {
    const token = ++request.current; setOpening(true);
    let preparing = false;
    try {
      const page: CharacterBrowsePage = isManualFavorite(chosen.id) ? { items: [], nextCursor: null, totalCount: 0 } : await browseFavoriteAssets(chosen);
      if (request.current !== token) return;
      if (kind === "detail") { gridScroll.current = gridRef.current?.scrollTop ?? 0; preparing = true; setPendingDetail({ id: chosen.id, page }); }
      else setCover({ id: chosen.id, page });
      setError(null);
    } catch (reason) {
      if (request.current === token) { setError(commandErrorMessage(reason, "캐릭터 에셋을 불러오지 못했습니다.")); setRetry(() => () => { void openPage(chosen, kind); }); }
    } finally { if (request.current === token && !preparing) setOpening(false); }
  };
  const folder = (chosen: CharacterTarget) => onNavigate({ kind: "classification", classificationId: chosen.seriesClassificationId!, characterId: chosen.id });
  const order = (ids: string[]) => {
    const command = reorderCommand(entries, visible.map(item => item.id), ids);
    if (command) void change([command]);
  };
  const move = (id: string, direction: OrderMove) => { const next = movedIds(visible.map(item => item.id), id, direction); if (next) order(next); };
  const menu = (chosen: CharacterTarget, ordering = true) => {
    const index = visible.findIndex(item => item.id === chosen.id);
    return [
      { id: "cover", label: "대표 이미지 바꾸기", disabled: opening || state.busy, onSelect: () => void openPage(chosen, "cover") },
      ...(!isManualFavorite(chosen.id) ? [{ id: "folder", label: "에셋 폴더 열기", onSelect: () => folder(chosen) }] : []),
      ...(ordering ? [
        { id: "forward", label: "앞으로", disabled: index <= 0 || state.busy, onSelect: () => move(chosen.id, "prev") },
        { id: "backward", label: "뒤로", disabled: index === visible.length - 1 || state.busy, onSelect: () => move(chosen.id, "next") },
        { id: "first", label: "맨 앞으로", disabled: index <= 0 || state.busy, onSelect: () => move(chosen.id, "first") },
        { id: "last", label: "맨 뒤로", disabled: index === visible.length - 1 || state.busy, onSelect: () => move(chosen.id, "last") },
      ] : []),
      { id: "remove", label: "캐릭터 목록에서 빼기", separatorBefore: true, disabled: state.busy, onSelect: () => { void change([{ op: "remove", ids: [chosen.id] }]).then(saved => { if (saved && detail?.id === chosen.id) { setDetail(null); setEditing(false); } }); } },
    ];
  };
  const add = catalog && <Menu label="캐릭터 추가" open={adding} onOpenChange={setAdding} align="end" trigger={<><PlusIcon aria-hidden="true" />추가</>} contentClassName="favorite-add-menu" content={<FavoriteAddPicker catalog={catalog} entries={entries} busy={state.busy} onClose={() => setAdding(false)} onAdd={ids => change([{ op: "add", ids }])} onCreate={async name => {
    const saved = await change([createFavoriteCommand(name)]);
    if (saved) setScope("all");
    return saved;
  }} />} />;
  const sectionDrop = useSectionDrop({ label: "분류함", options: scopes, value: effectiveScope, onChange: setScope,
    trailing: <>{shortcuts}<span className="collection-shortcuts__divider" aria-hidden="true" />{add}</> }, !target || !entry, "캐릭터");
  const message = error ?? state.error ?? catalogError;
  return <section className="favorite-view" aria-label="캐릭터">
    <ViewToolbar title={target && entry ? target.displayName : "캐릭터"} sectionDrop={target && entry ? undefined : sectionDrop}
      leadingAction={<Button size="icon" variant="ghost" aria-label={detail ? "캐릭터 목록으로 돌아가기" : "컬렉션으로 돌아가기"} onClick={back}><ArrowLeftIcon aria-hidden="true" /></Button>}
      titleAccessory={!target && <span className="collection-toolbar__count">{targets.length.toLocaleString("ko-KR")}</span>}
      trailingAction={target && entry ? <><Button variant="quiet" size="sm" disabled={editing} onClick={() => setEditing(true)}><PencilIcon aria-hidden="true" />편집</Button><Menu label="캐릭터 더보기" align="end" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={menu(target, false)} /></> : undefined}
      chrome={{}} />
    <div className="favorite-view__body">
      <div className="favorite-view__scroll" ref={detailRef} data-motion-view="favorite-detail" style={{ visibility: showingDetail ? undefined : "hidden", opacity: showingDetail ? undefined : 0 }} inert={!showingDetail || undefined} aria-hidden={!showingDetail || undefined}>
      {detailTarget && detailEntry && displayedDetail && catalog && <FavoriteDetail target={detailTarget} entry={detailEntry} catalog={catalog} initialPage={displayedDetail.page} collections={collections} editing={editing} busy={state.busy}
        onEdit={setEditing} onSave={save} onCover={() => void openPage(detailTarget, "cover")} onFolder={() => folder(detailTarget)} linkPicker={<Menu label="에셋 캐릭터와 연결" open={linking} onOpenChange={setLinking} trigger="에셋 캐릭터와 연결" contentClassName="favorite-add-menu" content={<FavoriteAddPicker catalog={catalog} entries={entries} busy={opening || state.busy} onClose={() => setLinking(false)} onLink={link} />} />} onWork={work => {
          favoritePlaces.set(root, { open: true, scope, detail, scrollTop: detailRef.current?.scrollTop ?? 0, gridScrollTop: gridRef.current?.scrollTop ?? 0 }); onWork(work);
        }} />}
      </div>
      <div className="favorite-view__scroll" ref={gridRef} style={{ visibility: showingDetail ? "hidden" : undefined }} inert={showingDetail || undefined} aria-hidden={showingDetail || undefined}>
        {sectionDrop.inline}
        {(!catalog || !state.document) ? (!message && <div className="favorite-grid">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="favorite-skeleton" />)}</div>)
          : !targets.length ? <EmptyState title="캐릭터 목록이 비어 있습니다" action={<Button onClick={() => setAdding(true)}>캐릭터 추가</Button>} />
            : <FavoriteGrid targets={visible} entries={entries} catalog={catalog} disabled={opening || state.busy} menu={menu} onOpen={chosen => void openPage(chosen, "detail")} onOrder={order} />}
      </div>
    </div>
    <span className="favorite-view__busy" role="status"><BusyLabel busy={opening} delay={400}>에셋 확인 중</BusyLabel></span>
    {message && <Toast tone="error" actionLabel="다시 시도" onAction={() => { if (retry) retry(); else { void state.refresh(); if (catalogError) onRefreshCatalog(); } }}>{message}</Toast>}
    {cover && catalog && (() => {
      const chosen = targets.find(item => item.id === cover.id), saved = entries.find(item => item.characterId === cover.id);
      return chosen && saved ? <FavoriteCoverDialog target={chosen} entry={saved} initialPage={cover.page} busy={state.busy} onClose={() => setCover(null)} onSave={set => change([{ op: "update", id: chosen.id, set }])} /> : null;
    })()}
  </section>;
}
