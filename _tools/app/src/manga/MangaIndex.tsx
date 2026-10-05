import { BusyLabel } from "../shared/ui/BusyLabel";
import { useEffect, useRef, useState } from "react";
import { FolderIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { MangaFrequentIndex, MangaIndexEntry, MangaIndexIdentity, MangaLocalIndex } from "../library/types";
import { CATALOG_BOOKMARKS_CHANGED_EVENT } from "../app/useCatalogBookmarkSync";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { mangaIndexKey } from "./mangaIndexModel";
import type { MangaSource } from "./MangaToolbar";
import "./MangaIndex.css";
import { IconButton } from "../shared/ui/IconButton";
import { PinIcon, PinSolidIcon } from "../shared/ui/PinIcon";

type Props = {
  source: MangaSource;
  filter: MangaIndexIdentity | null;
  onFilter: (filter: MangaIndexIdentity | null) => void;
  folder: string | null;
  onFolder: (folder: string | null) => void;
  localCount: number;
  revision: unknown;
  onLocalIndex: (index: MangaLocalIndex) => void;
  onPurge: () => Promise<void>;
};
export function MangaIndex({ source, filter, onFilter, folder, onFolder, localCount, revision, onLocalIndex, onPurge }: Props) {
  const { gateway } = useLibrary();
  const [frequent, setFrequent] = useState<MangaFrequentIndex | null>(null);
  const [pins, setPins] = useState<MangaIndexIdentity[]>([]);
  const [local, setLocal] = useState<MangaLocalIndex | null>(null);
  const [expanded, setExpanded] = useState({ tag: false, artist: false });
  const [review, setReview] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const loadedLocal = useRef(onLocalIndex); loadedLocal.current = onLocalIndex;
  const catalogRequest = useRef(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const request = ++catalogRequest.current;
      try {
        const [next, pinned] = await Promise.all([gateway.getMangaFrequentIndex?.(), gateway.listMangaIndexPins?.()]);
        if (!active || request !== catalogRequest.current) return;
        if (next) setFrequent(next);
        if (pinned) setPins(pinned);
      } catch { if (active) setMessage("목차를 불러오지 못했습니다"); }
    };
    void load();
    window.addEventListener(CATALOG_BOOKMARKS_CHANGED_EVENT, load);
    return () => { active = false; window.removeEventListener(CATALOG_BOOKMARKS_CHANGED_EVENT, load); };
  }, [gateway, revision]);
  useEffect(() => {
    if (source !== "local" || !gateway.getMangaLocalIndex) return;
    let active = true;
    void gateway.getMangaLocalIndex().then(next => {
      if (active) { setLocal(next); loadedLocal.current(next); }
    }).catch(error => {
      if (active) {
        setLocal(null); setReview(false); setSelected(new Set());
        loadedLocal.current({ folders: [], vanished: [] });
        setMessage(commandErrorMessage(error, "폴더 목록을 불러오지 못했습니다"));
      }
    });
    return () => { active = false; };
  }, [gateway, source, revision]);
  const pinnedKeys = new Set(pins.map(mangaIndexKey));
  async function togglePin(row: MangaIndexIdentity) {
    if (pinBusy) return;
    const key = mangaIndexKey(row);
    setPinBusy(key);
    // A delayed initial/bookmark load cannot overwrite the acknowledged pin mutation.
    catalogRequest.current += 1;
    try {
      if (pinnedKeys.has(key)) await gateway.removeMangaIndexPin?.(row);
      else await gateway.addMangaIndexPin?.(row);
      const next = await gateway.listMangaIndexPins?.();
      catalogRequest.current += 1;
      if (next) setPins(next);
    } catch { setMessage("고정을 변경하지 못했습니다"); }
    finally { setPinBusy(null); }
  }
  function row(entry: MangaIndexIdentity, count: number, pinned: boolean) {
    const key = mangaIndexKey(entry);
    const active = filter !== null && mangaIndexKey(filter) === key;
    return <div key={key} className={`manga-index__row${pinned ? " manga-index__row--pinned" : ""}`}>
      <button type="button" className="classification-sidebar__quick-view" aria-label={`${entry.label} ${count}`} aria-current={active ? "page" : undefined} onClick={() => onFilter(active ? null : entry)}>
        <span className="classification-sidebar__quick-view-surface"><span className="classification-sidebar__quick-view-label">{entry.label}</span><span className="manga-index__count">{count}</span></span>
      </button>
      <IconButton className="manga-index__pin" label={`${entry.label} ${pinned ? "고정 해제" : "고정"}`} icon={PinIcon} activeIcon={PinSolidIcon} active={pinned} disabled={pinBusy !== null} onClick={() => void togglePin(entry)} />
    </div>;
  }
  function frequentSection(kind: "tag" | "artist", entries: MangaIndexEntry[], limit: number, title: string) {
    const visible = entries.filter(entry => !pinnedKeys.has(mangaIndexKey(entry)));
    return <section aria-label={title}><SectionLabel title={title} />
      {(expanded[kind] ? visible : visible.slice(0, limit)).map(entry => row(entry, entry.count, false))}
      {visible.length > limit && <button className="manga-index__more" type="button" aria-expanded={expanded[kind]} onClick={() => setExpanded(current => ({ ...current, [kind]: !current[kind] }))}>{expanded[kind] ? "접기" : `모두 보기 (${visible.length})`}</button>}
    </section>;
  }
  async function purge() {
    if (!gateway.purgeVanishedMangaFolders || busy || selected.size === 0) return;
    setBusy(true);
    try {
      const result = await gateway.purgeVanishedMangaFolders([...selected]);
      setReview(false);
      const completed = `폴더 ${result.removedFolders.length}개 · 작품 ${result.removedSeriesCount}개 정리했습니다. 백업 완료`;
      setMessage(completed);
      try {
        await onPurge();
        const next = await gateway.getMangaLocalIndex?.();
        if (next) { setLocal(next); loadedLocal.current(next); }
        if (folder && result.removedFolders.some(f => f.relativePath === folder)) onFolder(null);
      } catch (error) {
        setLocal(null); setSelected(new Set());
        loadedLocal.current({ folders: [], vanished: [] });
        const reason = typeof error === "object" && error !== null && "code" in error && error.code === "unsafe_manga_root"
          ? commandErrorMessage(error, "드라이브 연결 상태를 확인하세요")
          : "목록을 새로 불러오지 못했습니다";
        setMessage(`${completed}. ${reason}`);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "unsafe_manga_root") {
        setLocal(null); setReview(false); setSelected(new Set());
        loadedLocal.current({ folders: [], vanished: [] });
        setMessage(commandErrorMessage(error, "드라이브 연결 상태를 확인하세요"));
      } else {
        setMessage("폴더를 정리하지 못했습니다. 폴더와 백업 상태를 확인하세요");
      }
    }
    finally { setBusy(false); }
  }
  return <nav className="manga-index" aria-label="망가 목차">
    {source === "local" ? local && (local.folders.length > 0 || local.vanished.length > 0 || localCount > 0) && <>
      <SectionLabel title="폴더" />
      <button type="button" className="classification-sidebar__quick-view" aria-label={`전체 ${localCount}`} aria-current={folder === null ? "page" : undefined} onClick={() => onFolder(null)}><span className="classification-sidebar__quick-view-surface"><FolderIcon aria-hidden="true" /><span className="classification-sidebar__quick-view-label">전체</span><span className="manga-index__count">{localCount}</span></span></button>
      {local?.folders.map(entry => <button key={entry.relativePath} type="button" className="classification-sidebar__quick-view" aria-label={`${entry.name} ${entry.seriesCount}`} aria-current={folder === entry.relativePath ? "page" : undefined} onClick={() => onFolder(entry.relativePath)}><span className="classification-sidebar__quick-view-surface"><FolderIcon aria-hidden="true" /><span className="classification-sidebar__quick-view-label">{entry.name}</span><span className="manga-index__count">{entry.seriesCount}</span></span></button>)}
      {local && local.vanished.length > 0 && <div className="manga-index__gone"><span>없어진 폴더 {local.vanished.length}개 · 디스크에서 사라짐</span><Button size="sm" variant="quiet" onClick={() => { setSelected(new Set(local.vanished.map(f => f.relativePath))); setMessage(null); setReview(true); }}>목록 보기</Button></div>}
    </> : <>
      {pins.length > 0 && <section aria-label="고정"><SectionLabel title="고정" />{pins.map(pin => row(pin, [...frequent?.tags ?? [], ...frequent?.artists ?? []].find(entry => mangaIndexKey(entry) === mangaIndexKey(pin))?.count ?? 0, true))}</section>}
      {frequent?.bookmarkCount === 0 ? <p className="manga-index__note">북마크한 작품이 생기면 자주 찾는 태그와 작가가 여기에 모입니다.</p> : frequent && <>{frequentSection("tag", frequent.tags, frequent.tagLimit, "자주 찾는 태그")}{frequentSection("artist", frequent.artists, frequent.artistLimit, "작가")}</>}
    </>}
    {message && !review && <p role="status" className="manga-index__note">{message}</p>}
    {review && local && <Dialog open title={`없어진 폴더 ${local.vanished.length}개`} onClose={() => { if (!busy) setReview(false); }}>
      <p>고른 폴더를 라이브러리를 백업한 뒤 망가 목록에서 지웁니다. 디스크의 파일은 건드리지 않습니다.</p>
      {local.vanished.map(entry => <label key={entry.relativePath} className="manga-index__vanished"><input type="checkbox" checked={selected.has(entry.relativePath)} disabled={busy} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(entry.relativePath); else next.delete(entry.relativePath); return next; })} /><span>{entry.name}<small>{entry.relativePath}</small></span><span className="manga-index__count">{entry.seriesCount}개 작품</span></label>)}
      {message && <p role="alert">{message}</p>}
      <div className="ui-dialog__actions"><Button disabled={busy} variant="ghost" onClick={() => setReview(false)}>취소</Button><Button disabled={busy || selected.size === 0} variant="primary" onClick={() => void purge()}><BusyLabel busy={!!(busy)} idle={`백업하고 ${selected.size}개 지우기`}>백업하고 정리 중…</BusyLabel></Button></div>
    </Dialog>}
  </nav>;
}
export function MangaIndexToken({ filter, onClear }: { filter: MangaIndexIdentity | null; onClear: () => void }) {
  return filter ? <span className="manga-index-token">{filter.label}<button type="button" aria-label={`${filter.label} 필터 해제`} onClick={onClear}>×</button></span> : null;
}
