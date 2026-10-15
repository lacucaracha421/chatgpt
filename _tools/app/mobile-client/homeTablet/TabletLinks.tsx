import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {LinkIcon} from '@heroicons/react/24/outline';
import type {NotesStore} from '../../src/notes/store';
import {domain, findLinksNote, keepLink, linkTime, linkUrl, newLinksNote, parseLinks, readLinksId, serializeLinks, writeLinksId, type KeptLink} from '../../src/home/links';
import {StableImage} from '../../src/shared/ui/StableImage';
import {Button, EmptyState, SectionLabel, TextInput} from '../ui';
import {errorText, native} from '../transport';

const EMPTY = {ready: false, unlocked: false, notes: []} as unknown as ReturnType<NotesStore['snapshot']>;
const noSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY;
const SHOWN = 4;

type Props = {store: NotesStore | null; root: string; privacy: boolean; onOpenNotes(): void; open?(url: string): Promise<unknown>};

const openInBrowser = (url: string) => native('openExternal', {url});

/** Only a stored https thumbnail is loaded; the tablet has no preview fetcher, so the PC fills previews in. */
// No empty thumbnail box (user 2026-10-16): a link without a usable https image shows text only.
function Thumb({url, privacy}: {url?: string | null; privacy: boolean}) {
  if (!url || !/^https:\/\//.test(url)) return null;
  if (privacy) return <span className="home-tab-link__thumb"><span className="home-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" /></span>;
  return <span className="home-tab-link__thumb"><StableImage src={url} alt="" loading="lazy" /></span>;
}

/**
 * 링크 보관 on the tablet: the same dedicated note and JSON format as the PC (shared `links.ts`), added by
 * pasting a URL. A link is stored without a preview; the PC enriches it later.
 */
export function TabletLinks({store, root, privacy, onOpenNotes, open = openInBrowser}: Props) {
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
  const [error, setError] = useState<string | null>(null);
  let links: KeptLink[] = [], parseError: string | null = null;
  try { links = parseLinks(note?.body ?? ''); } catch { parseError = '링크 보관 메모의 형식을 확인해 주세요. 원문은 메모에 보관되어 있습니다.'; }
  const locked = !store || !state.ready || !state.unlocked || !!state.keyringLocked || !!note?.concealed || !!note?.readOnly;
  const disabled = locked || !!note?.conflict || !!parseError;

  function add(value: string) {
    if (disabled || !store) return;
    const url = linkUrl(value);
    if (!url) { setError('http 또는 https URL을 붙여넣어 주세요.'); return; }
    const snapshot = store.snapshot();
    const current = findLinksNote(snapshot.notes, id.current.value);
    if (!snapshot.unlocked || snapshot.keyringLocked || current?.conflict || current?.concealed || current?.readOnly) return;
    let next: KeptLink[];
    try { next = keepLink(parseLinks(current?.body ?? ''), url); }
    catch { setError('링크 보관 메모의 형식을 확인해 주세요.'); return; }
    const updated = current ? {...current, body: serializeLinks(next)} : newLinksNote(next);
    id.current.value = updated.id; writeLinksId(root, updated.id);
    store.edit(updated);
    void store.finish();
    setInput(''); setError(null);
  }
  const shown = links.slice(0, SHOWN);
  const status = parseError ?? (state.ready && locked ? (note?.concealed ? '숨긴 메모입니다' : '메모를 열어야 쓸 수 있습니다') : null);
  return <section className="home-attention-section home-tool home-tab-links" aria-label="링크 보관">
    <SectionLabel title="링크 보관" />
    <div className="home-tool__body">
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
        {!locked && shown.map(link => <button type="button" className="home-tab-link" key={link.url} onClick={() => { void open(link.url).catch(reason => setError(errorText(reason) || '링크를 열지 못했습니다.')); }}>
          <Thumb url={link.imageUrl} privacy={privacy} />
          <span className="home-tab-link__copy"><span>{link.title || domain(link.url)}</span><small>{[link.siteName || domain(link.url), Date.parse(link.savedAt) > 0 ? linkTime(link.savedAt) : ''].filter(Boolean).join(' · ')}</small></span>
        </button>)}
      </div>
      {!disabled && !shown.length && <EmptyState inline title="보관할 URL을 붙여넣어 주세요" />}
      {(error ?? state.error) && <p className="home-tab-links__status" role="status">{error ?? state.error}</p>}
    </div>
  </section>;
}
