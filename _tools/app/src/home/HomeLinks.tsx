import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeftIcon, EllipsisHorizontalIcon, LinkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { TextInput } from "../shared/ui/TextInput";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Menu } from "../shared/ui/Menu";
import { StableImage } from "../shared/ui/StableImage";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { domain, findLinksNote, keepLink, linkTime, linkUrl, needsLinkTitle, newLinksNote, parseLinks, readLinksId, serializeLinks, sessionLinkPreview, withLinkPreview, writeLinksId, type KeptLink, type LinkPreview } from "./links";
import "./homeTools.css";
import "./homeLinks.css";

export const homeLinksApi = {
  preview: (url: string) => invoke<LinkPreview>("home_link_preview", { url }),
  thumbnail: (url: string) => invoke<string>("home_link_thumbnail", { url }),
  importImages: (root: string, url: string, imageUrl?: string | null) => invoke<{ imported: number; message: string | null }>("home_link_import", { root, url, imageUrl: imageUrl ?? null }),
  open: (url: string) => openUrl(url),
  copy: (url: string) => navigator.clipboard.writeText(url),
};
type Props = { store: NotesStore | null; root: string; onOpenNotes: () => void; expanded?: boolean; onOpen?: () => void; onBack?: () => void; api?: typeof homeLinksApi };
const EMPTY = { ready: false, unlocked: false, notes: [] } as unknown as ReturnType<NotesStore["snapshot"]>;
const noSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY;

export function HomeLinks({ store, root, onOpenNotes, expanded = false, onOpen, onBack, api = homeLinksApi }: Props) {
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? emptySnapshot);
  const { privacyMode } = usePrivacy();
  const id = useRef({ root, value: readLinksId(root) });
  if (id.current.root !== root) id.current = { root, value: readLinksId(root) };
  const note = findLinksNote(state.notes, id.current.value);
  useEffect(() => { if (note) { id.current.value = note.id; writeLinksId(root, note.id); } }, [note, root]);
  useEffect(() => {
    if (state.moved?.from === id.current.value) { id.current.value = state.moved.to; writeLinksId(root, state.moved.to); store?.clearMoved(); }
  }, [state.moved, store, root]);
  useEffect(() => () => { void store?.finish(); }, [store]);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<"all" | "images">("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const [imports, setImports] = useState<Set<string>>(new Set());
  const importLocks = useRef(new Set<string>());
  const delayedBusy = useDelayedBusy(busy > 0, { delay: 400 });
  let links: KeptLink[] = [], parseError: string | null = null;
  try { links = parseLinks(note?.body ?? ""); } catch { parseError = "링크 보관 메모의 형식을 확인해 주세요. 원문은 메모에 보관되어 있습니다."; }
  const locked = !store || !state.ready || !state.unlocked || !!state.keyringLocked || !!note?.concealed || !!note?.readOnly;
  const disabled = locked || !!note?.conflict || !!parseError;
  function mutate(change: (current: KeptLink[]) => KeptLink[], expectedId?: string, expectedRoot = root) {
    if (!store) return null;
    const snapshot = store.snapshot();
    const current = findLinksNote(snapshot.notes, id.current.value);
    if (id.current.root !== expectedRoot || !snapshot.ready || !snapshot.unlocked || snapshot.keyringLocked || current?.conflict || current?.concealed || current?.readOnly || (expectedId && current?.id !== expectedId)) return null;
    let next: KeptLink[];
    try {
      const previous = parseLinks(current?.body ?? "");
      next = change(previous);
      if (current && next.length === previous.length && next.every((link, index) => link === previous[index])) return current.id;
    }
    catch { setError("링크 보관 메모의 형식을 확인해 주세요."); return null; }
    const updated = current ? { ...current, body: serializeLinks(next) } : newLinksNote(next);
    if (current?.body === updated.body) return current.id;
    id.current.value = updated.id; writeLinksId(root, updated.id);
    store.edit(updated);
    void store.finish();
    return updated.id;
  }
  async function add(value: string) {
    if (disabled) return;
    const url = linkUrl(value);
    if (!url) { setError("http 또는 https URL을 붙여넣어 주세요."); return; }
    let exists = false;
    const noteId = mutate(current => { exists = current.some(link => link.url === url); return keepLink(current, url); });
    if (!noteId) return;
    setInput(""); setError(null);
    if (exists) return;
    setBusy(n => n + 1);
    try {
      const preview = await sessionLinkPreview(api, url);
      mutate(current => current.map(link => link.url === url ? withLinkPreview(link, preview) : link), noteId);
    } catch { /* The saved URL remains usable if preview fails. */ }
    finally { setBusy(n => n - 1); }
  }
  async function importImages(link: KeptLink) {
    if (disabled || importLocks.current.has(link.url)) return;
    importLocks.current.add(link.url); setImports(new Set(importLocks.current)); setBusy(n => n + 1); setError(null);
    const noteId = note?.id;
    try {
      const result = await api.importImages(root, link.url, link.imageUrl);
      if (result.imported) mutate(current => current.map(row => row.url === link.url ? { ...row, imported: (row.imported ?? 0) + result.imported } : row), noteId);
      if (result.message) setError(result.message);
    } catch { setError("이미지를 가져오지 못했습니다. 다시 시도해 주세요."); }
    finally { importLocks.current.delete(link.url); setImports(new Set(importLocks.current)); setBusy(n => n - 1); }
  }
  const action = (operation: () => Promise<unknown>) => { void operation().catch(() => setError("작업을 완료하지 못했습니다. 다시 시도해 주세요.")); };
  const shown = (filter === "images" ? links.filter(link => link.imageUrl) : links).slice(0, expanded ? undefined : 4);
  useEffect(() => {
    if (disabled || !note) return;
    let live = true;
    const noteId = note.id;
    void (async () => {
      for (const link of shown.filter(needsLinkTitle)) {
        if (!live) break;
        try {
          const preview = await sessionLinkPreview(api, link.url);
          if (live) mutate(current => current.map(row => row.url === link.url ? withLinkPreview(row, preview) : row), noteId, root);
        } catch { /* Keep the row usable; sessionLinkPreview caches failures. */ }
      }
    })();
    return () => { live = false; };
    // The body captures edits from other devices; never replace a title added while awaiting a preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, disabled, note?.id, note?.body, root, store, expanded, filter]);
  const body = <div className={expanded ? "home-links-view" : "home-tool__body"} onDragOver={event => { if (!disabled && (event.dataTransfer.types.includes("text/uri-list") || event.dataTransfer.types.includes("text/plain"))) { event.preventDefault(); event.stopPropagation(); } }}
    onDrop={event => { const text = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line => line && !line.startsWith("#")) || event.dataTransfer.getData("text/plain"); if (text) { event.preventDefault(); event.stopPropagation(); void add(text); } }}>
    <div className="home-links__bar">
      {expanded && <SegmentedControl label="링크 필터" value={filter} onChange={setFilter} options={[{ value: "all", label: "전체", count: links.length }, { value: "images", label: "이미지 있음", count: links.filter(link => link.imageUrl).length }]} />}
      <form className="home-links__input" onSubmit={event => { event.preventDefault(); void add(input); }}>
        <LinkIcon className="home-links__icon" aria-hidden="true" />
        <TextInput aria-label="URL 붙여넣기" placeholder={expanded ? "URL 붙여넣기 · 끌어 놓기" : "URL 붙여넣기"} value={input} disabled={disabled} onChange={event => setInput(event.target.value)}
          onPaste={event => { const text = event.clipboardData.getData("text/plain"); if (linkUrl(text)) { event.preventDefault(); void add(text); } }} />
        <kbd>Ctrl+V</kbd>
        {input && <Button variant="quiet" size="sm" type="submit" disabled={disabled}>보관</Button>}
      </form>
    </div>
    {((state.ready && locked) || parseError) && <p className="home-links__status"><span>{parseError ?? (note?.concealed ? "숨긴 메모입니다" : "메모를 열어야 쓸 수 있습니다")}</span><Button variant="quiet" size="sm" onClick={onOpenNotes}>메모 열기</Button></p>}
    {note?.conflict && <p className="home-links__status">다른 기기 수정과 충돌했습니다.<Button variant="quiet" size="sm" disabled={state.syncing || state.saving} onClick={() => void store?.resolve(note, true)}>내 내용 보관 후 서버 버전 불러오기</Button></p>}
    <div className={expanded ? "home-links__grid" : "home-links__rows"}>
      {!locked && shown.map(link => <article className={`home-link${expanded ? " home-link--grid" : ""}`} key={link.url}>
        <button type="button" className="home-link__open" onClick={() => action(() => api.open(link.url))}>
          <LinkThumbnail url={link.imageUrl} masked={privacyMode} api={api} />
          <span className="home-link__copy"><span>{link.title || domain(link.url)}</span><small>{domain(link.url)} · {linkTime(link.savedAt)}</small></span>
        </button>
        <div className="home-link__actions">
          {link.imageUrl && (link.imported ? <span className="home-link__done">기타에 {link.imported}장 넣음</span> : <Button variant="quiet" size="sm" disabled={disabled || imports.has(link.url)} onClick={() => void importImages(link)}>이미지를 에셋으로</Button>)}
          {expanded && <Menu label={`${link.title} 더보기`} trigger={<EllipsisHorizontalIcon className="home-links__icon" aria-hidden="true" />} items={[
            { id: "open", label: "열기", onSelect: () => action(() => api.open(link.url)) },
            { id: "copy", label: "복사", onSelect: () => action(() => api.copy(link.url)) },
            { id: "import", label: "이미지를 에셋으로", disabled: disabled || !link.imageUrl || imports.has(link.url) || !!link.imported, onSelect: () => void importImages(link) },
            { id: "delete", label: "삭제", destructive: true, disabled, onSelect: () => { mutate(current => current.filter(row => row.url !== link.url)); } },
          ]} />}
        </div>
      </article>)}
    </div>
    {!disabled && !shown.length && <EmptyState inline title={filter === "images" ? "이미지가 있는 링크가 없습니다" : "보관할 URL을 붙여넣어 주세요"} />}
    <div className="home-links__feedback" role="status">{error ?? state.error ?? (delayedBusy ? "링크 작업 중" : "")}</div>
  </div>;
  return expanded ? <div className="home-view home-links-screen"><ViewToolbar title="링크 보관" leadingAction={<Button variant="quiet" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />홈</Button>} titleAccessory={<span className="numeric">{links.length}</span>} /><div className="home-scroll">{body}</div></div>
    : <section className="home-attention-section home-tool home-links" aria-label="링크 보관"><SectionLabel title="링크 보관" actions={<Button variant="quiet" size="sm" onClick={onOpen}>전체</Button>} />{body}</section>;
}

function LinkThumbnail({ url, masked, api }: { url?: string | null; masked: boolean; api: typeof homeLinksApi }) {
  const [loaded, setLoaded] = useState<{ url: string; src: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { let live = true; if (url && !masked) void api.thumbnail(url).then(src => { if (live) setLoaded({ url, src }); }, () => { if (live) setFailed(url); }); return () => { live = false; }; }, [url, masked, api]);
  // No empty thumbnail box (user 2026-10-16): only links with an image that loads (or is masked) get one.
  if (!url || failed === url) return null;
  return <span className={`home-link__thumb${masked ? " privacy-mask" : ""}`} aria-label={masked ? "이미지 숨김" : undefined}>{!masked && loaded && loaded.url === url && <StableImage src={loaded.src} alt="" />}</span>;
}
