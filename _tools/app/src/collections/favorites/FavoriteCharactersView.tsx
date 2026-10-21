import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { containerId, favoriteScopes, reorderCommand } from "./model";
import { browseFavoriteAssets, type FavoriteCatalog } from "./useFavoriteCatalog";
import type { useFavoriteCharacters } from "./useFavoriteCharacters";
import { FavoriteAddPicker } from "./FavoriteAddPicker";
import { FavoriteCoverDialog } from "./FavoriteCoverDialog";
import { FavoriteDetail } from "./FavoriteDetail";
import { FavoriteGrid } from "./FavoriteGrid";
import "./favorites.css";

// Reopening a linked work returns to the same character and loaded asset page.
export const favoritePlaces = new Map<string, { open: boolean; scope: string; detail: { id: string; page: CharacterBrowsePage } | null; scrollTop: number }>();

export function FavoriteCharactersView({ root, state, catalog, catalogError, collections, shortcuts, onBack, onNavigate, onWork, onRefreshCatalog }: {
  root: string; state: ReturnType<typeof useFavoriteCharacters>; catalog: FavoriteCatalog | null; catalogError: string | null;
  collections: CollectionSummary[]; shortcuts: ReactNode; onBack(): void; onNavigate(view: AssetView): void; onWork(work: CollectionSummary): void; onRefreshCatalog(): void;
}) {
  const place = favoritePlaces.get(root);
  const [scope, setScope] = useState(place?.scope ?? "all");
  const [detail, setDetail] = useState(place?.detail ?? null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cover, setCover] = useState<{ id: string; page: CharacterBrowsePage } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const request = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridScroll = useRef(place?.detail ? 0 : place?.scrollTop ?? 0);
  const shownDetail = useRef(detail?.id);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || shownDetail.current === detail?.id) return;
    if (detail) scroller.scrollTop = 0;
    else scroller.scrollTop = gridScroll.current;
    shownDetail.current = detail?.id;
  }, [detail?.id]);
  const entries = state.document?.entries ?? [];
  const targets = entries.flatMap(entry => catalog?.targets.find(target => target.id === entry.characterId) ?? []);
  const scopes = favoriteScopes(targets, catalog?.classifications ?? []);
  const effectiveScope = scopes.some(option => option.value === scope) ? scope : "all";
  const visible = targets.filter(target => effectiveScope === "all" || containerId(target, catalog!.classifications) === effectiveScope);
  const target = catalog?.targets.find(item => item.id === detail?.id);
  const entry = entries.find(item => item.characterId === detail?.id);
  const current = useRef({ scope, detail }); current.current = { scope, detail };
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = favoritePlaces.get(root)?.scrollTop ?? 0;
    return () => {
      request.current++;
      if (favoritePlaces.get(root)?.open !== false) favoritePlaces.set(root, { open: true, ...current.current, scrollTop: scroller?.scrollTop ?? 0 });
    };
  }, [root]);
  const back = () => {
    if (editing) { setEditing(false); return; }
    if (detail) { setDetail(null); return; }
    onBack();
  };
  useBackHandler(back, 20, true);
  const change = async (commands: Parameters<typeof state.change>[0]) => {
    const saved = await state.change(commands);
    if (!saved) setRetry(() => () => { void change(commands); });
    else setRetry(null);
    return saved;
  };
  const save = (set: FavoriteSet) => change([{ op: "update", id: target!.id, set }]);
  const openPage = async (chosen: CharacterTarget, kind: "detail" | "cover") => {
    const token = ++request.current; setOpening(true);
    try {
      const page = await browseFavoriteAssets(chosen);
      if (request.current !== token) return;
      if (kind === "detail") { gridScroll.current = scrollRef.current?.scrollTop ?? 0; setDetail({ id: chosen.id, page }); setEditing(false); }
      else setCover({ id: chosen.id, page });
      setError(null);
    } catch (reason) {
      if (request.current === token) { setError(commandErrorMessage(reason, "캐릭터 에셋을 불러오지 못했습니다.")); setRetry(() => () => { void openPage(chosen, kind); }); }
    } finally { if (request.current === token) setOpening(false); }
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
      { id: "folder", label: "에셋 폴더 열기", onSelect: () => folder(chosen) },
      ...(ordering ? [
        { id: "forward", label: "앞으로", disabled: index <= 0 || state.busy, onSelect: () => move(chosen.id, "prev") },
        { id: "backward", label: "뒤로", disabled: index === visible.length - 1 || state.busy, onSelect: () => move(chosen.id, "next") },
        { id: "first", label: "맨 앞으로", disabled: index <= 0 || state.busy, onSelect: () => move(chosen.id, "first") },
        { id: "last", label: "맨 뒤로", disabled: index === visible.length - 1 || state.busy, onSelect: () => move(chosen.id, "last") },
      ] : []),
      { id: "remove", label: "캐릭터 목록에서 빼기", separatorBefore: true, disabled: state.busy, onSelect: () => { void change([{ op: "remove", ids: [chosen.id] }]).then(saved => { if (saved && detail?.id === chosen.id) { setDetail(null); setEditing(false); } }); } },
    ];
  };
  const add = catalog && <Menu label="캐릭터 추가" open={adding} onOpenChange={setAdding} align="end" trigger={<><PlusIcon aria-hidden="true" />추가</>} contentClassName="favorite-add-menu" content={<FavoriteAddPicker catalog={catalog} entries={entries} busy={state.busy} onClose={() => setAdding(false)} onAdd={ids => change([{ op: "add", ids }])} />} />;
  const sectionDrop = useSectionDrop({ label: "분류함", options: scopes, value: effectiveScope, onChange: setScope,
    trailing: <>{shortcuts}<span className="collection-shortcuts__divider" aria-hidden="true" />{add}</> }, !target || !entry, "캐릭터");
  const message = error ?? state.error ?? catalogError;
  return <section className="favorite-view" aria-label="캐릭터">
    <ViewToolbar title={target && entry ? target.displayName : "캐릭터"} sectionDrop={target && entry ? undefined : sectionDrop}
      leadingAction={<Button size="icon" variant="ghost" aria-label={detail ? "캐릭터 목록으로 돌아가기" : "컬렉션으로 돌아가기"} onClick={back}><ArrowLeftIcon aria-hidden="true" /></Button>}
      titleAccessory={!target && <span className="collection-toolbar__count">{targets.length.toLocaleString("ko-KR")}</span>}
      trailingAction={target && entry ? <><Button variant="quiet" size="sm" disabled={editing} onClick={() => setEditing(true)}><PencilIcon aria-hidden="true" />편집</Button><Menu label="캐릭터 더보기" align="end" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={menu(target, false)} /></> : undefined}
      chrome={{}} />
    <div className="favorite-view__scroll" ref={scrollRef}>
      {target && entry && detail && catalog ? <FavoriteDetail key={target.id} target={target} entry={entry} catalog={catalog} initialPage={detail.page} collections={collections} editing={editing} busy={state.busy}
        onEdit={setEditing} onSave={save} onCover={() => void openPage(target, "cover")} onFolder={() => folder(target)} onWork={work => {
          favoritePlaces.set(root, { open: true, scope, detail, scrollTop: scrollRef.current?.scrollTop ?? 0 }); onWork(work);
        }} /> : <>
        {sectionDrop.inline}
        {(!catalog || !state.document) ? (!message && <div className="favorite-grid">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="favorite-skeleton" />)}</div>)
          : !targets.length ? <EmptyState title="캐릭터 목록이 비어 있습니다" action={<Button onClick={() => setAdding(true)}>캐릭터 추가</Button>} />
            : <FavoriteGrid targets={visible} entries={entries} catalog={catalog} disabled={opening || state.busy} menu={menu} onOpen={chosen => void openPage(chosen, "detail")} onOrder={order} />}
      </>}
    </div>
    <span className="favorite-view__busy" role="status"><BusyLabel busy={opening} delay={400}>에셋 확인 중</BusyLabel></span>
    {message && <Toast tone="error" actionLabel="다시 시도" onAction={() => { if (retry) retry(); else { void state.refresh(); if (catalogError) onRefreshCatalog(); } }}>{message}</Toast>}
    {cover && catalog && (() => {
      const chosen = catalog.targets.find(item => item.id === cover.id), saved = entries.find(item => item.characterId === cover.id);
      return chosen && saved ? <FavoriteCoverDialog target={chosen} entry={saved} initialPage={cover.page} busy={state.busy} onClose={() => setCover(null)} onSave={set => change([{ op: "update", id: chosen.id, set }])} /> : null;
    })()}
  </section>;
}
