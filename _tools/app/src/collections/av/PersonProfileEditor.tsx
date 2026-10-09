import {useState, type ComponentType, type ReactNode} from 'react';
import {PlusIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button} from '../../shared/ui/Button';
import {IconButton} from '../../shared/ui/IconButton';
import {Dialog} from '../../shared/ui/Dialog';
import {TextInput} from '../../shared/ui/TextInput';
import {Select} from '../../shared/ui/Select';
import {BusyLabel} from '../../shared/ui/BusyLabel';
import {displayDate} from '../../shared/displayDate';
import {applyProfileChanges, cmToInches, inchesToCm, ownsProfile, profileBase, profileGroups, profileKeys, profileValue, profileToken, sameProfileValue, validateProfileCareer, validateProfileChanges, type ProfileChanges, type ProfileExpected, type ProfileKey, type ProfilePerson, type ProfileValue} from './personProfileFields';
import './personProfileEditor.css';

export function profileGroupText(person: ProfilePerson, keys: ProfileKey[], source = false) {
  const read = (key: ProfileKey) => source ? profileBase(person, key) : profileValue(person, key);
  if (keys[0] === 'urls') return source ? `링크 ${Array.isArray(read('urls')) ? (read('urls') as unknown[]).length : 0}개` : Array.isArray(read('urls')) && (read('urls') as unknown[]).length ? (read('urls') as {site: string; url: string}[]).map(v => v.site || v.url).join(' · ') : '비움';
  if (keys[0] === 'bandIn') return keys.some(key => typeof read(key) === 'number') ? keys.map((key, i) => `${['B', 'W', 'H'][i]}${typeof read(key) === 'number' ? inchesToCm(read(key) as number) : ' 비움'}`).join(' ') : '비움';
  if (keys[0] === 'careerStart') return read('careerStart') !== null || read('careerEnd') !== null ? `${read('careerStart') ?? '비움'} – ${read('careerEnd') ?? '현역'}` : '비움';
  const value = read(keys[0]);
  if (value === null || value === '' || Array.isArray(value) && !value.length) return '비움';
  if (keys[0] === 'heightCm') return `${value} cm`;
  if (keys[0] === 'birthDate') return displayDate(String(value));
  if (keys[0] === 'breastType') return value === 'NATURAL' ? '자연' : value === 'FAKE' ? '인공' : '모름';
  return String(value);
}
export const resetProfileGroup = (keys: ProfileKey[]): ProfileChanges => Object.fromEntries(keys.map(key => [key, {reset: true}]));

/** Editor order: short facts share rows (생년월일 · 키 · 컵 · 가슴, then 사이즈 · 활동); any later group is appended. */
const editorOrder: ProfileKey[] = ['displayName', 'nameJa', 'birthDate', 'heightCm', 'cup', 'breastType', 'bandIn', 'careerStart', 'urls'];
const editorGroups = [...editorOrder.flatMap(key => profileGroups.filter(group => group.keys[0] === key)), ...profileGroups.filter(group => !editorOrder.includes(group.keys[0]))];
/** Inputs sized to their content: a year 4, month/day 2, cm 3, cup up to 3 characters. */
type TextOptions = {number?: boolean; measure?: boolean; chars?: 2 | 3 | 4; placeholder?: string};

export type ProfileSurfaceProps = {title: string; onClose(): void; children: ReactNode};
function ProfileDialog({title, onClose, children}: ProfileSurfaceProps) { return <Dialog open title={title} onClose={onClose} variant="medium">{children}</Dialog>; }
type EditorProps = {surface?: ComponentType<ProfileSurfaceProps>; person: ProfilePerson; onClose(): void; onSave(changes: ProfileChanges, expected: ProfileExpected): Promise<void>; disabled?: boolean};
export function PersonProfileEditor(props: EditorProps) {
  const [reload, setReload] = useState(0);
  return <ProfileEditorDraft key={reload} {...props} onReload={() => setReload(value => value + 1)}/>;
}
const baselineLabel = (keys: ProfileKey[]) => keys.some(key => key === 'displayName' || key === 'nameJa') ? '원래 이름' : 'StashDB';
function ProfileEditorDraft({surface: Surface = ProfileDialog, person, onClose, onSave, disabled = false, onReload}: EditorProps & {onReload(): void}) {
  // Freeze the draft's initial values: a receipt or provider refresh never erases typing.
  const [initial] = useState(() => structuredClone(person));
  const [initialTokens] = useState(() => Object.fromEntries(profileKeys.map(key => [key, profileToken(initial, key)])));
  const [changes, setChanges] = useState<ProfileChanges>({});
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(profileKeys.filter(key => key !== 'urls').map(key => {
    const value = profileValue(person, key);
    return [key, value === null ? '' : ['bandIn', 'waistIn', 'hipIn'].includes(key) && typeof value === 'number' ? String(inchesToCm(value)) : String(value)];
  })));
  const [links, setLinks] = useState<{site: string; url: string}[]>(() => Array.isArray(profileValue(person, 'urls')) ? profileValue(person, 'urls') as {site: string; url: string}[] : []);
  const [linksCleared, setLinksCleared] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false), [tried, setTried] = useState(false);
  const requestClose = () => { if (busy) return; if (Object.keys(changes).length) setDiscardOpen(true); else onClose(); };
  const validLink = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value); } catch { return false; } };
  const effective = applyProfileChanges(initial, changes), linked = !!initial.stashdbId;
  const updated = (person.entityRevision ?? 0) > (initial.entityRevision ?? 0) || profileKeys.some(key => !sameProfileValue(profileToken(initial, key), profileToken(person, key)) || !sameProfileValue(profileBase(initial, key), profileBase(person, key)));
  const put = (key: ProfileKey, value: ProfileValue) => setChanges(previous => {
    const next = {...previous};
    const original = profileValue(initial, key);
    const unchangedEmptyLinks = key === 'urls' && !ownsProfile(initial, key) && (value === null || Array.isArray(value) && !value.length) && (original === null || Array.isArray(original) && !original.length);
    if (key === 'urls' && linksCleared && (value === null || Array.isArray(value) && !value.length)) next[key] = null;
    else if (unchangedEmptyLinks || sameProfileValue(value, original)) delete next[key]; else next[key] = value;
    return next;
  });
  const reset = (keys: ProfileKey[]) => {
    const next = {...changes, ...resetProfileGroup(keys)};
    setChanges(next);
    const restored = applyProfileChanges(initial, next);
    setDraft(previous => ({...previous, ...Object.fromEntries(keys.filter(key => key !== 'urls').map(key => {
      const value = profileValue(restored, key); return [key, value === null ? '' : ['bandIn', 'waistIn', 'hipIn'].includes(key) && typeof value === 'number' ? String(inchesToCm(value)) : String(value)];
    }))}));
    if (keys.includes('urls')) { setLinksCleared(false); setLinks((profileValue(restored, 'urls') as {site: string; url: string}[] | null) ?? []); }
  };
  const text = (key: ProfileKey, label: string, {number = false, measure = false, chars, placeholder}: TextOptions = {}) => <TextInput aria-label={label} className={chars ? `person-profile-editor__short person-profile-editor__short--${chars}` : undefined} placeholder={placeholder} value={draft[key]} inputMode={number ? 'numeric' : undefined} maxLength={key === 'cup' ? 20 : 500} disabled={busy || disabled} onChange={event => {
    const raw = event.target.value; setDraft(previous => ({...previous, [key]: raw}));
    const original = profileValue(initial, key);
    const originalDisplay = measure && typeof original === 'number' ? String(inchesToCm(original)) : original === null ? '' : String(original);
    put(key, raw === originalDisplay ? original : raw.trim() === '' ? null : number ? measure ? cmToInches(Number(raw)) : Number(raw) : raw.trim());
  }} onBlur={measure ? () => { const raw = draft[key]; const original = profileValue(initial, key); if (typeof original === 'number' && raw === String(inchesToCm(original))) return; if (raw.trim() && Number.isFinite(Number(raw))) setDraft(previous => ({...previous, [key]: String(inchesToCm(cmToInches(Number(raw))))})); } : undefined}/>;
  const unit = (value: string) => <span className="person-profile-editor__unit" aria-hidden="true">{value}</span>;
  /** One input with its unit or letter, held together when the row wraps. */
  const piece = (first: ReactNode, second: ReactNode, third?: ReactNode) => <span className="person-profile-editor__piece">{first}{second}{third}</span>;
  const [birth, setBirth] = useState(() => (draft.birthDate || '').split('-'));
  const birthInput = (index: number, label: string) => <TextInput aria-label={label} className={`person-profile-editor__short person-profile-editor__short--${index === 0 ? 4 : 2}`} inputMode="numeric" maxLength={index === 0 ? 4 : 2} value={birth[index] ?? ''} disabled={busy || disabled} onChange={event => {
    const next = [...birth]; next[index] = event.target.value; setBirth(next);
    const value = next[0] ? `${next[0]}${next[1] ? `-${next[1].padStart(2, '0')}` : ''}${next[2] ? `-${next[2].padStart(2, '0')}` : ''}` : next.slice(1).some(Boolean) ? 'invalid' : null;
    put('birthDate', next[2] && !next[1] ? 'invalid' : value);
  }}/>;
  const save = async () => {
    setTried(true);
    try {
      if (!Object.keys(changes).length) { onClose(); return; }
      validateProfileChanges(changes); validateProfileCareer(initial, changes);
      if (Array.isArray(changes.urls) && links.some(link => !validLink(link.url))) throw new Error('https 주소를 입력해 주세요.');
      setBusy(true); setError(''); await onSave(changes, Object.fromEntries(Object.keys(changes).map(key => [key, initialTokens[key]]))); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '프로필을 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  return <Surface title="프로필 편집" onClose={requestClose}>
    <div className="person-profile-editor">
      {updated && <p role="status">다른 기기에서 바뀌었어요 · <Button variant="quiet" disabled={busy} onClick={onReload}>새로 불러오기</Button></p>}
      {linked && profileKeys.some(key => ownsProfile(effective, key)) && <Button variant="quiet" disabled={busy || disabled} onClick={() => { reset(profileGroups.filter(group => group.keys.some(key => ownsProfile(effective, key))).flatMap(group => group.keys)); setBirth((profileBase(initial, 'birthDate') as string | null ?? '').split('-')); }}>모두 되돌리기</Button>}
      <div className="person-profile-editor__grid">{editorGroups.map(group => <section className={`person-profile-editor__field person-profile-editor__field--${group.keys[0]}`} key={group.label}>
        <div className="person-profile-editor__label">{group.label}{linked && group.keys.some(key => ownsProfile(effective, key)) && <span>직접 입력</span>}
          {group.keys[0] === 'urls' && <div className="person-profile-editor__link-actions"><Button variant="quiet" disabled={links.length >= 100 || busy || disabled} onClick={() => { const next = [...links, {site: '', url: ''}]; setLinks(next); put('urls', next); }}><PlusIcon aria-hidden="true"/>링크 추가</Button><Button variant="quiet" disabled={busy || disabled} onClick={() => { setLinksCleared(true); setLinks([]); setChanges(previous => ({...previous, urls: null})); }}>비우기</Button></div>}</div>
        {group.keys[0] === 'birthDate' ? <div className="person-profile-editor__inline">{piece(birthInput(0, '출생 연도'), unit('년'))}{piece(birthInput(1, '출생 월'), unit('월'))}{piece(birthInput(2, '출생 일'), unit('일'))}</div>
          : group.keys[0] === 'heightCm' ? <div className="person-profile-editor__inline">{piece(text('heightCm', '키 (cm)', {number: true, chars: 3}), unit('cm'))}</div>
          : group.keys[0] === 'cup' ? text('cup', '컵', {chars: 3})
          : group.keys[0] === 'bandIn' ? <div className="person-profile-editor__inline">{piece(unit('B'), text('bandIn', 'B (cm)', {number: true, measure: true, chars: 3}))}{piece(unit('W'), text('waistIn', 'W (cm)', {number: true, measure: true, chars: 3}))}{piece(unit('H'), text('hipIn', 'H (cm)', {number: true, measure: true, chars: 3}), unit('cm'))}</div>
          : group.keys[0] === 'careerStart' ? <div className="person-profile-editor__inline">{text('careerStart', '활동 시작', {number: true, chars: 4})}{unit('–')}{text('careerEnd', '활동 종료 (빈칸은 현역)', {number: true, chars: 4, placeholder: '현역'})}</div>
          : group.keys[0] === 'breastType' ? <Select label="가슴" value={draft.breastType} disabled={busy || disabled} onChange={event => { setDraft(previous => ({...previous, breastType: event.target.value})); put('breastType', event.target.value || null); }}><option value="">비움</option><option value="NATURAL">자연</option><option value="FAKE">인공</option><option value="NA">모름</option></Select>
          : group.keys[0] === 'urls' ? links.length > 0 && <div className="person-profile-editor__links">{links.map((link, index) => <div className="person-profile-editor__link" key={index}><TextInput aria-label={`링크 ${index + 1} 사이트 이름`} placeholder="사이트 이름" value={link.site} maxLength={200} disabled={busy || disabled} onChange={event => { const next = links.map((item, i) => i === index ? {...item, site: event.target.value} : item); setLinks(next); put('urls', next); }}/><TextInput aria-label={`링크 ${index + 1} URL`} placeholder="https://…" aria-invalid={Array.isArray(changes.urls) && !!(link.url || tried) && !validLink(link.url)} value={link.url} maxLength={2000} disabled={busy || disabled} onChange={event => { const next = links.map((item, i) => i === index ? {...item, url: event.target.value} : item); setLinks(next); put('urls', next); }}/><IconButton label={`링크 ${index + 1} 제거`} icon={XMarkIcon} disabled={busy || disabled} onClick={() => { const next = links.filter((_, i) => i !== index); setLinks(next); put('urls', next.length ? next : null); }}/>{Array.isArray(changes.urls) && (link.url || tried) && !validLink(link.url) && <small className="person-profile-editor__url-error" role="alert">https 주소를 입력해 주세요.</small>}</div>)}</div>
          : text(group.keys[0], group.label)}
        {linked && group.keys.some(key => ownsProfile(effective, key)) && <div className="person-profile-editor__source"><span>{baselineLabel(group.keys)} {profileGroupText(initial, group.keys, true)}</span><Button variant="quiet" size="sm" disabled={busy || disabled} onClick={() => { reset(group.keys); if (group.keys.includes('birthDate')) setBirth((profileBase(initial, 'birthDate') as string | null ?? '').split('-')); }}>되돌리기</Button></div>}
        {group.keys.some(key => ownsProfile(effective, key)) && profileGroupText(effective, group.keys) === '비움' && <small>비움</small>}
      </section>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button disabled={busy} onClick={requestClose}>취소</Button><Button variant="primary" disabled={busy || disabled} onClick={() => void save()}><BusyLabel busy={busy} delay={400} idle="저장">저장 중</BusyLabel></Button></div>
      {discardOpen && <Dialog open title="편집한 내용을 버릴까요?" onClose={() => setDiscardOpen(false)}><div className="ui-dialog__actions"><Button onClick={() => setDiscardOpen(false)}>계속 편집</Button><Button variant="primary" onClick={onClose}>버리기</Button></div></Dialog>}
    </div>
  </Surface>;
}
/** The same compare content is used inside the PC popover and tablet sheet. */
export function ProfileCompare({person, keys, onReset, onEdit, disabled = false}: {person: ProfilePerson; keys: ProfileKey[]; onReset(): void; onEdit(): void; disabled?: boolean}) {
  return <div className="person-profile-compare"><dl><div><dt>내 값</dt><dd>{profileGroupText(person, keys)}</dd></div><div><dt>{baselineLabel(keys)}</dt><dd>{profileGroupText(person, keys, true)}</dd></div></dl><div className="ui-dialog__actions"><Button disabled={disabled} onClick={onReset}>되돌리기</Button><Button disabled={disabled} onClick={onEdit}>편집</Button></div></div>;
}
