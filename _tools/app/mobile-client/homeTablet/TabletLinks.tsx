import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {LinkIcon} from '@heroicons/react/24/outline';
import type {NotesStore} from '../../src/notes/store';
import {domain, findLinksNote, keepLink, linkTime, linkUrl, newLinksNote, parseLinks, readLinksId, serializeLinks, sessionLinkPreview, withLinkPreview, writeLinksId, type KeptLink, type LinkPreview} from '../../src/home/links';
import {StableImage} from '../../src/shared/ui/StableImage';
import {Button, EmptyState, SectionLabel, TextInput} from '../ui';
import {api, errorText, native} from '../transport';
import {writeClipboard} from '../ViewerInfo';
import {SegmentedControl} from '../../src/shared/ui/SegmentedControl';

const EMPTY = {ready: false, unlocked: false, notes: []} as unknown as ReturnType<NotesStore['snapshot']>;
const noSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY;
const SHOWN = 4;

type Props = {store: NotesStore | null; root: string; privacy: boolean; /** Lists every kept link instead of the newest few (the full 링크 보관 sheet). */ all?: boolean; onOpenNotes(): void; open?(url: string): Promise<unknown>; previews?: LinkPreviewSource};
type LinkPreviewSource = {preview(url: string): Promise<LinkPreview>};

const openInBrowser = (url: string) => native('openExternal', {url});
/** The server reads the title/thumbnail of the one link just kept (parity U02); one app-lifetime object keys the shared preview queue. */
const serverPreviews: LinkPreviewSource = {preview: url => api<LinkPreview>('/v1/home/link-preview', undefined, {url}, 'POST')};

/** Only a stored https thumbnail is loaded. */
// No empty thumbnail box (user 2026-10-16): a link without a usable https image shows text only.
function Thumb({url, privacy}: {url?: string | null; privacy: boolean}) {
  if (!url || !/^https:\/\//.test(url)) return null;
  if (privacy) return <span className="home-tab-link__thumb"><span className="home-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" /></span>;
  return <span className="home-tab-link__thumb"><StableImage src={url} alt="" loading="lazy" /></span>;
}

/**
 * 링크 보관 on the tablet: the same dedicated note and JSON format as the PC (shared `links.ts`), added by
 * pasting a URL. A new link is stored at once and its preview (title, site, thumbnail) is filled in when the
 * server has read it; if that fails, the PC still enriches it later.
 */
export function TabletLinks({store, root, privacy, all = false, onOpenNotes, open = openInBrowser, previews = serverPreviews}: Props) {
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? emptySnapshot);
  const id = useRef({root, value: readLinksId(root)});
  if (id.current.root !== root) id.current = {root, value: readLinksId(root)};
  const note = findLinksNote(state.notes, id.current.value);
  useEffect(() => { if (note) { id.current.value = note.id; writeLinksId(root, note.id); } }, [note, root]);
  useEffect(() => {
    if (state.moved?.from === id.current.value) { id.current.value = state.moved.to; writeLinksId(root, state.moved.to); store?.clearMoved(); }
  }, [state.moved, store, root]);
  useEffect(() => () => { void store?.finish(); }, [store]);
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<'all'|'images'>('all');
  const [error, setError] = useState<string | null>(null);
  let links: KeptLink[] = [], parseError: string | null = null;
  try { links = parseLinks(note?.body ?? ''); } catch { parseError = '링크 보관 메모의 형식을 확인해 주세요. 원문은 메모에 보관되어 있습니다.'; }
  const locked = !store || !state.ready || !state.unlocked || !!state.keyringLocked || !!note?.concealed || !!note?.readOnly;
  const disabled = locked || !!note?.conflict || !!parseError;

  function mutate(change: (links: KeptLink[]) => KeptLink[]) {
    if (disabled || !store) return;
    const snapshot = store.snapshot();
    const current = findLinksNote(snapshot.notes, id.current.value);
    if (!snapshot.ready || !snapshot.unlocked || snapshot.keyringLocked || current?.conflict || current?.concealed || current?.readOnly) return;
    let next: KeptLink[];
    try { next = change(parseLinks(current?.body ?? '')); }
    catch { setError('링크 보관 메모의 형식을 확인해 주세요.'); return; }
    const updated = current ? {...current, body: serializeLinks(next)} : newLinksNote(next);
    if (current && current.body === updated.body) return true;
    id.current.value = updated.id; writeLinksId(root, updated.id);
    store.edit(updated);
    void store.finish();
    setError(null);
    return true;
  }
  function add(value: string) {
    const url = linkUrl(value);
    if (!url) { setError('http 또는 https URL을 붙여넣어 주세요.'); return; }
    let exists = false;
    if (!mutate(current => { exists = current.some(link => link.url === url); return keepLink(current, url); })) return;
    setInput(''); setError(null);
    if (exists) return;
    // The saved URL stays usable when the preview fails; the PC can still fill it in.
    void sessionLinkPreview(previews, url).then(preview => { mutate(current => current.map(link => link.url === url ? withLinkPreview(link, preview) : link)); }, () => undefined);
  }
  const filtered = filter === 'images' ? links.filter(link => link.imageUrl) : links;
  const shown = all ? filtered : filtered.slice(0, SHOWN);
  const status = parseError ?? (state.ready && locked ? (note?.concealed ? '숨긴 메모입니다' : '메모를 열어야 쓸 수 있습니다') : null);
  return <section className="home-attention-section home-tool home-tab-links" aria-label="링크 보관">
    <SectionLabel title="링크 보관" />
    <div className="home-tool__body">
      {all && <SegmentedControl label="링크 필터" value={filter} onChange={setFilter} options={[{value:'all',label:'전체',count:links.length},{value:'images',label:'이미지 있음',count:links.filter(link=>link.imageUrl).length}]}/>}
      <form className="home-tab-links__input" onSubmit={event => { event.preventDefault(); add(input); }}>
        <LinkIcon className="home-tab-links__icon" aria-hidden="true" />
        <TextInput aria-label="URL 붙여넣기" placeholder="URL 붙여넣기" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={input} disabled={disabled}
          onChange={event => setInput(event.target.value)}
          onPaste={event => { const text = event.clipboardData.getData('text/plain'); if (linkUrl(text)) { event.preventDefault(); add(text); } }} />
        {input && <Button variant="quiet" type="submit" disabled={disabled}>보관</Button>}
      </form>
      {status && <p className="home-tab-links__status" role="status"><span>{status}</span><Button variant="quiet" onClick={onOpenNotes}>메모 열기</Button></p>}
      {note?.conflict && <p className="home-tab-links__status" role="status"><span>다른 기기 수정과 충돌했습니다.</span><Button variant="quiet" disabled={state.syncing || state.saving} onClick={() => void store?.resolve(note, true)}>내 내용 보관 후 서버 버전 불러오기</Button></p>}
      <div className="home-tab-links__rows">
        {!locked && shown.map(link => <article className="home-tab-links__row" key={link.url}><button type="button" className="home-tab-link" onClick={() => { void open(link.url).catch(reason => setError(errorText(reason) || '링크를 열지 못했습니다.')); }}>
          <Thumb url={link.imageUrl} privacy={privacy} />
          <span className="home-tab-link__copy"><span>{link.title || domain(link.url)}</span><small>{[link.siteName || domain(link.url), Date.parse(link.savedAt) > 0 ? linkTime(link.savedAt) : ''].filter(Boolean).join(' · ')}</small></span>
        </button>{all && <div className="home-tab-links__actions"><Button variant="quiet" aria-label={`${link.title || domain(link.url)} 복사`} onClick={()=>void writeClipboard(link.url).catch(reason=>setError(errorText(reason)))}>복사</Button><Button variant="quiet" aria-label={`${link.title || domain(link.url)} 삭제`} disabled={disabled} onClick={()=>mutate(current=>current.filter(row=>row.url!==link.url))}>삭제</Button></div>}</article>)}
      </div>
      {!disabled && !shown.length && <EmptyState inline title={filter==='images'?'이미지가 있는 링크가 없습니다':'보관할 URL을 붙여넣어 주세요'} />}
      {(error ?? state.error) && <p className="home-tab-links__status" role="status">{error ?? state.error}</p>}
    </div>
  </section>;
}
