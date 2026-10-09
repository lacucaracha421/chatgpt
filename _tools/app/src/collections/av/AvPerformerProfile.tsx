import {performerName} from "./performerName";
import { inchesToCm } from "./personProfileFields";
import { AvStashdbImage } from "./AvStashdbImage";
import { EmptyState } from "../../shared/ui/EmptyState";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { ArrowPathIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { displayDate, displayDateTime } from "../../shared/displayDate";
import { openUrl } from "@tauri-apps/plugin-opener";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { Menu } from "../../shared/ui/Menu";
import { Badge } from "../../shared/ui/Badge";
import "./avPerformerProfile.css";
import { Dialog } from "../../shared/ui/Dialog";
import type { AvGateway, AvPerformerProfile as Profile, AvProfileCandidate, AvStashdbStatus } from "../avTypes";

/** Provider errors are redacted, localized by the native relay boundary. */
function failure(reason: unknown, fallback: string): string {
  return reason && typeof reason === "object" && "code" in reason && (reason.code === "collection_authority_operation_unavailable" || String(reason.code).startsWith("av_stashdb_")) && "message" in reason && typeof reason.message === "string" ? reason.message : fallback;
}

export function safeProfileUrl(value: string): boolean {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function birthLabel(value: string, today: Date) {
  const display = displayDate(value, today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return display;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return display;
  const age = today.getFullYear() - year - (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day) ? 1 : 0);
  return age >= 0 ? <>{display} <small>만 {age}세</small></> : display;
}
function linkInfo(link: Profile["urls"][number]) {
  const name = link.site.name.toLowerCase();
  const url = new URL(link.url);
  if (name === "twitter" || name === "x" || ["twitter.com", "x.com"].includes(url.hostname)) return { priority: 0, label: "X" };
  if (name === "instagram") return { priority: 1, label: "Instagram" };
  if (name.includes("dmm") || name.includes("fanza")) return { priority: 2, label: "FANZA" };
  if (["studio profile", "modeling agency"].includes(name)) return { priority: 3, label: "공식" };
  if (name === "wikipedia" || url.hostname.endsWith(".wikipedia.org")) return { priority: url.hostname === "ja.wikipedia.org" ? 4 : 5, label: "위키" };
  return { priority: 6, label: link.site.name || url.hostname };
}
export function ProfileRows({ profile, today = new Date() }: { profile: Profile; today?: Date }) {
  const measurements = [profile.bandIn ? `B${inchesToCm(profile.bandIn)}${profile.cup ? ` (${profile.cup})` : ""}` : null, profile.waistIn ? `W${inchesToCm(profile.waistIn)}` : null, profile.hipIn ? `H${inchesToCm(profile.hipIn)}` : null].filter(Boolean).join(" ");
  const breast = profile.breastType === "NATURAL" ? "자연" : profile.breastType === "FAKE" ? "인공" : null;
  const career = profile.careerStart !== null ? <>{profile.careerStart} – {profile.careerEnd ?? "현역"} <small>{profile.careerEnd !== null ? "· 은퇴" : `${Math.max(1, today.getFullYear() - profile.careerStart)}년차`}</small></> : profile.careerEnd !== null ? <>{profile.careerEnd} · 은퇴</> : null;
  if (!profile.birthDate && !profile.heightCm && !measurements && !profile.cup && !breast && !career) return null;
  return <dl className="av-profile__rows" aria-label="프로필">
    {profile.birthDate && <div><dt>생년월일</dt><dd>{birthLabel(profile.birthDate, today)}</dd></div>}
    {profile.heightCm !== null && <div><dt>키</dt><dd>{profile.heightCm} cm</dd></div>}
    {measurements && <div><dt>사이즈</dt><dd>{measurements}</dd></div>}
    {(profile.cup || breast) && <div><dt>컵</dt><dd>{profile.cup && `${profile.cup}컵`} {breast && <Badge>{breast}</Badge>}</dd></div>}
    {career && <div className="av-profile__career"><dt>활동</dt><dd>{career}</dd></div>}
  </dl>;
}
function profileDisplayLinks(profile: Pick<Profile, "urls">) {
  const seen = new Set<string>();
  return profile.urls.filter(link => {
    if (!safeProfileUrl(link.url)) return false;
    const normalized = new URL(link.url).href;
    if (seen.has(normalized)) return false;
    seen.add(normalized); return true;
  }).map(link => ({ ...link, ...linkInfo(link) })).sort((a, b) => a.priority - b.priority);
}
export function ProfileLinks({ profile, openLink = openUrl, disabled = false }: { profile: Pick<Profile, "urls">; openLink?: (url: string) => Promise<void>; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  const links = profileDisplayLinks(profile);
  if (!links.length) return null;
  return <><div className="av-profile__links" aria-label="배우 링크">
    {(expanded ? links : links.slice(0, 5)).map(link => <Button key={link.url} size="sm" variant="quiet" disabled={disabled} onClick={() => { void openLink(link.url).catch(() => setError(true)); }}>{link.label}</Button>)}
    {expanded && <Button size="sm" variant="quiet" disabled={disabled} aria-expanded={true} onClick={() => setExpanded(false)}>접기</Button>}
    {!expanded && links.length > 5 && <Button size="sm" variant="quiet" disabled={disabled} aria-expanded={false} aria-label={`링크 ${links.length - 5}개 더 보기`} onClick={() => setExpanded(true)}>+{links.length - 5}</Button>}
  </div>{error && <p className="av-profile__quiet" role="status">링크를 열지 못했습니다.</p>}</>;
}

export function AvPerformerProfile({ personId, api, onOpenSettings, displayName, nameJa, compact = false, hideRows = false, hideLinks = false, renderRows }: { renderRows?: (profile: Profile | null) => ReactNode; hideLinks?: boolean; hideRows?: boolean; compact?: boolean; displayName?: string; nameJa?: string | null; personId: string; api: AvGateway; onOpenSettings?: () => void }) {
  const { privacyMode } = usePrivacy();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadedPersonId, setLoadedPersonId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [status, setStatus] = useState<AvStashdbStatus | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AvProfileCandidate[] | null>(null);
  const request = useRef(0);
  const loadingPerson = loadedPersonId !== personId;
  const actionable = !loadingPerson;
  useEffect(() => {
    const current = ++request.current;
    let active = true;
    setLoadedPersonId(null); setConfirmClear(null);
    setConfigured(null); setStatus(null); setCandidates(null); setError(null); setBusy(false);
    const stored = api.getPerformerProfile(personId).then(value => { if (active && current === request.current) { setProfile(value); setLoadedPersonId(personId); } }).catch(() => { if (active && current === request.current) { setProfile(null); setLoadedPersonId(personId); setError("StashDB 프로필을 불러오지 못했습니다."); } });
    const status = api.getStashdbCredentialStatus().then(value => { if (active) { setConfigured(value.configured); setStatus(value); } return value; });
    void Promise.all([stored, status]).then(async ([, provider]) => {
      if (!active || current !== request.current || !provider.configured || provider.routed) return;
      setBusy(true);
      const value = await api.refreshPerformerProfile(personId, false);
      if (active && current === request.current) { setProfile(value); setError(null); }
    }).catch(reason => { if (active && current === request.current) setError(failure(reason,"StashDB 정보를 확인하지 못했습니다. 다시 시도해 주세요.")); })
      .finally(() => { if (active && current === request.current) setBusy(false); });
    return () => { active = false; request.current++; };
  }, [api, personId]);

  useEffect(() => {
    if (!status?.routed) return;
    let active = true;
    let reading = false;
    const reload = () => {
      if (!active || reading) return;
      reading = true;
      const current = request.current;
      void api.getPerformerProfile(personId).then(value => {
        if (active && current === request.current) setProfile(value);
      }).catch(() => {}).finally(() => { reading = false; });
    };
    const stop = api.subscribeProfilesChanged?.(reload);
    const timer = profile?.pending ? window.setInterval(reload, 1500) : undefined;
    return () => { active = false; stop?.(); if (timer !== undefined) window.clearInterval(timer); };
  }, [api, personId, status?.routed, profile?.pending]);

  async function clear() {
    if (busy || !actionable || !status?.routed || confirmClear !== personId) return;
    setConfirmClear(null);
    setBusy(true); setError(null);
    const current = ++request.current;
    try {
      await api.clearPerformerProfile(personId);
      const next = await api.getPerformerProfile(personId);
      if (current === request.current) setProfile(next);
    } catch (reason) { if (current === request.current) setError(failure(reason,"StashDB 연결을 해제하지 못했습니다.")); }
    finally { if (current === request.current) setBusy(false); }
  }

  async function refresh(chooser = false) {
    if (busy || !actionable) return;
    const current = ++request.current;
    setBusy(true); setError(null);
    try {
      const next = chooser ? await api.searchPerformerProfile(personId) : await api.refreshPerformerProfile(personId, true);
      if (current !== request.current) return;
      if (chooser) setCandidates(next?.candidates ?? []); else setProfile(next);
    } catch (reason) { if (current === request.current) setError(failure(reason, "StashDB 정보를 확인하지 못했습니다. 다시 시도해 주세요.")); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function choose(id: string | null) {
    if (busy || !actionable) return;
    const current = ++request.current;
    setBusy(true); setError(null);
    try {
      const next = id ? await api.choosePerformerProfile(personId, id) : await api.dismissPerformerProfile(personId);
      if (current === request.current) { if (id || !status?.routed) setProfile(next); setCandidates(null); }
    } catch (reason) { if (current === request.current) setError(failure(reason, "StashDB 연결을 저장하지 못했습니다.")); }
    finally { if (current === request.current) setBusy(false); }
  }

  if (configured === false && !status?.routed && !renderRows) return <p className="av-profile__quiet">StashDB 키가 없어요 · <button type="button" onClick={onOpenSettings}>설정</button></p>;
  const aliases = [...new Set([profile?.name, ...(profile?.aliases ?? [])].filter((name): name is string => Boolean(name?.trim())).map(name => name.trim()))].filter(name => name !== displayName && name !== nameJa);
  return <div className="av-profile" aria-busy={busy || loadingPerson} inert={loadingPerson || undefined}>
    {renderRows?.(loadingPerson ? null : profile)}
    {configured === false && !status?.routed && <p className="av-profile__quiet">StashDB 키가 없어요 · <button type="button" onClick={onOpenSettings}>설정</button></p>}
    {status?.routed && status.supported === false && <p className="av-profile__quiet" role="status">서버가 아직 StashDB 조회를 지원하지 않습니다.</p>}
    {status?.routed && status.supported !== false && configured === false && <p className="av-profile__quiet" role="status">서버에 StashDB 키가 설정되지 않았습니다.</p>}
    {profile?.syncIssue && <p className="av-profile__quiet" role="status">StashDB 변경을 반영하지 못했습니다. 동기화 상태에서 충돌 또는 실패를 확인해 주세요.</p>}
    {profile?.pending && <p className="av-profile__quiet" role="status">StashDB 변경을 서버에 반영할 예정입니다.</p>}
    {status?.routed && profile?.status === "matched" && !profile.stashdbId && <p className="av-profile__quiet">StashDB 배우를 검색에서 다시 선택해 주세요.</p>}
    {status?.routed && (!profile || profile.status === "none") && configured && status.supported !== false && <Button size="sm" variant="quiet" disabled={!actionable || busy} onClick={() => void refresh(true)}>StashDB 배우 찾기</Button>}
    {profile?.status === "matched" && <>
      {!compact && aliases.length > 0 && <p className="av-profile__aliases">{aliases.slice(0, 3).join(" · ")}</p>}
      {!hideRows && !renderRows && <ProfileRows profile={profile} />}
      {!hideLinks && <ProfileLinks key={`${profile.personId}:${profile.stashdbId}`} profile={profile} disabled={!actionable} />}
      {compact ? <Menu key={personId} disabled={!actionable} label="StashDB 프로필" triggerClassName="av-profile__manage" trigger={<>StashDB<ChevronDownIcon aria-hidden="true" /></>} items={[
        ...(aliases.length ? [{ id: "aliases", label: aliases.slice(0, 3).join(" · "), disabled: true, onSelect: () => {} }] : []),
        { id: "checked", label: `${displayDateTime(profile.fetchedAt)} 확인`, disabled: true, onSelect: () => {} },
        { id: "refresh", label: "StashDB 새로고침", disabled: !actionable || busy || configured === false || status?.supported === false || (status?.routed && !profile.stashdbId), onSelect: () => void refresh() },
        { id: "choose", label: "다른 사람으로 바꾸기", disabled: !actionable || busy || configured === false || status?.supported === false, onSelect: () => void refresh(true) },
        ...(status?.routed ? [{ id: "clear", label: "StashDB 연결 해제", disabled: !actionable || busy || status.supported === false, onSelect: () => setConfirmClear(personId) }] : []),
        ...(!status?.routed && onOpenSettings ? [{ id: "settings", label: "설정", onSelect: onOpenSettings }] : []),
      ]} /> : <div className="av-profile__footer"><span>StashDB · {displayDateTime(profile.fetchedAt)} 확인</span><Button size="icon" variant="ghost" disabled={!actionable || busy || configured === false || status?.supported === false || !!(status?.routed && !profile.stashdbId)} aria-label="StashDB 새로고침" onClick={() => void refresh()}><ArrowPathIcon className={busy ? "av-profile__spinning" : ""} aria-hidden="true" /></Button>
      <Button size="sm" variant="quiet" className="av-profile__change" disabled={!actionable || busy || configured === false || status?.supported === false} onClick={() => void refresh(true)}>다른 사람으로 바꾸기</Button>{status?.routed && <Button size="sm" variant="quiet" disabled={!actionable || busy || status.supported === false} onClick={() => setConfirmClear(personId)}>StashDB 연결 해제</Button>}</div>}
    </>}
    {profile?.status === "ambiguous" && <p className="av-profile__quiet">StashDB에서 여러 명이 찾아졌어요 · <button type="button" disabled={!actionable || busy} onClick={() => setCandidates(profile.candidates)}>고르기</button></p>}
    {profile?.status === "none" && !profile.pending && !profile.syncIssue && <p className="av-profile__quiet">StashDB에서 못 찾았어요 · <button type="button" disabled={!actionable || busy || configured === false || status?.supported === false} onClick={() => void refresh(!!status?.routed)}>다시 찾기</button></p>}
    <BusyLabel busy={!!(!profile && busy)}><p className="av-profile__quiet" role="status">StashDB 확인 중…</p></BusyLabel>
    {!loadingPerson && error && <p className="av-profile__quiet" role="status">{error} <button type="button" disabled={!actionable || busy || status?.supported === false} onClick={() => void refresh(!!(status?.routed && !profile?.stashdbId))}>다시 시도</button></p>}
    {actionable && status?.routed && confirmClear === personId && <Dialog open title="StashDB 연결 해제" onClose={() => setConfirmClear(null)}>
      <p>StashDB 연결을 해제합니다. 직접 입력한 값과 대표 이미지는 유지됩니다.</p>
      <div className="ui-dialog__actions"><Button onClick={() => setConfirmClear(null)}>취소</Button><Button variant="danger" disabled={busy} onClick={() => void clear()}>연결 해제</Button></div>
    </Dialog>}
    {!loadingPerson && candidates !== null && <Dialog open title="StashDB 배우 고르기" onClose={() => { if (!busy) setCandidates(null); }}>
      <div className="av-profile__candidates">{candidates.map(candidate => <div className="av-profile__candidate" key={candidate.stashdbId}>
        {!privacyMode && status !== null && candidate.imageUrl && (status?.routed || safeProfileUrl(candidate.imageUrl)) && <AvStashdbImage url={candidate.imageUrl} routed={!!status?.routed} api={api} onError={reason => setError(failure(reason,"사진을 불러오지 못했습니다."))} />}
        <div><b>{performerName({name: candidate.name}).primary}</b><p>{candidate.aliases.join(" · ")}</p>{candidate.birthDate && <small>{displayDate(candidate.birthDate)}</small>}</div>
        <Button size="sm" disabled={!actionable || busy} onClick={() => void choose(candidate.stashdbId)}>이 사람</Button>
      </div>)}{candidates.length === 0 && <EmptyState inline title="검색 결과 없음" />}</div>
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button disabled={!actionable || busy} onClick={() => setCandidates(null)}>취소</Button><Button disabled={!actionable || busy} onClick={() => void choose(null)}>아무도 아님</Button></div>
    </Dialog>}
  </div>;
}
