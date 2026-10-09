import {createPortal} from "react-dom";
import {useLayoutEffect, useRef, useState, type ComponentType} from 'react';
import {ProfileCompare, profileGroupText, resetProfileGroup, type ProfileSurfaceProps} from './PersonProfileEditor';
import {ownsProfile, profileGroups, type ProfileChanges, type ProfileKey, type ProfilePerson} from './personProfileFields';

export function ProfileManualMark({person, keys, label, tablet = false, sheet: Sheet, disabled = false, onSave, onEdit}: {person: ProfilePerson; keys: ProfileKey[]; label: string; tablet?: boolean; sheet?: ComponentType<ProfileSurfaceProps>; disabled?: boolean; onSave(changes: ProfileChanges): Promise<void>; onEdit(): void}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const root = useRef<HTMLSpanElement>(null), popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({left: 0, top: 0});
  useLayoutEffect(() => {
    if (!open || tablet) return;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect(), panel = popover.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8));
      const below = anchor.bottom + 4;
      const top = below + panel.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - panel.height - 4);
      setPosition({left, top});
    };
    place(); popover.current?.focus();
    window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, tablet]);
  if (!person.stashdbId || !keys.some(key => ownsProfile(person, key))) return null;
  const content = <><ProfileCompare person={person} keys={keys} disabled={busy || disabled} onReset={() => { setBusy(true); void onSave(resetProfileGroup(keys)).then(() => setOpen(false), () => setError('되돌리지 못했습니다.')).finally(() => setBusy(false)); }} onEdit={() => { setOpen(false); onEdit(); }}/>{error && <p role="alert">{error}</p>}</>;
  return <span ref={root} className="person-profile-mark-wrap"><button type="button" className="person-profile-mark" disabled={disabled} aria-label={`${label} 직접 입력 비교`} aria-expanded={open} onClick={() => setOpen(value => !value)}>· 직접 입력</button>{open && (tablet && Sheet ? <Sheet title={`${label} 비교`} onClose={() => setOpen(false)}>{content}</Sheet> : createPortal(<div ref={popover} style={position} className="person-profile-popover" role="dialog" aria-label={`${label} 비교`} tabIndex={-1}>{content}</div>, document.body))}</span>;
}
export function PersonProfileRows(props: {person: ProfilePerson; sheet?: ComponentType<ProfileSurfaceProps>; tablet?: boolean; disabled?: boolean; onSave(changes: ProfileChanges): Promise<void>; onEdit(): void}) {
  return <dl className="av-profile__rows" aria-label="프로필">{profileGroups.filter(group => !['displayName', 'nameJa', 'urls'].includes(group.keys[0])).map(group => {
    const value = profileGroupText(props.person, group.keys);
    if (value === '비움' && !group.keys.some(key => ownsProfile(props.person, key))) return null;
    return <div key={group.label}><dt>{group.label}<ProfileManualMark {...props} label={group.label} keys={group.keys}/></dt><dd>{value}</dd></div>;
  })}</dl>;
}
