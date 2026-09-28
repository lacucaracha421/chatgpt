import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import type { AvGateway, AvPerformerProfile as Profile, AvProfileCandidate } from "../avTypes";

export function safeProfileUrl(value: string): boolean {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function birthLabel(value: string, today: Date) {
  const display = value.replace(/-/g, ".");
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
  if (["studio profile", "modeling agency"].includes(name)) return { priority: 3, label: "공식 프로필" };
  if (name === "wikipedia" || url.hostname.endsWith(".wikipedia.org")) return { priority: url.hostname === "ja.wikipedia.org" ? 4 : 5, label: url.hostname === "ja.wikipedia.org" ? "위키 (일본어)" : "위키" };
  return { priority: 6, label: link.site.name || url.hostname };
}
export function ProfileRows({ profile, today = new Date() }: { profile: Profile; today?: Date }) {
  const measurements = [profile.bandIn ? `B${Math.round(profile.bandIn * 2.54)}${profile.cup ? ` (${profile.cup})` : ""}` : null, profile.waistIn ? `W${Math.round(profile.waistIn * 2.54)}` : null, profile.hipIn ? `H${Math.round(profile.hipIn * 2.54)}` : null].filter(Boolean).join(" ");
  const breast = profile.breastType === "NATURAL" ? "자연" : profile.breastType === "FAKE" ? "보형" : null;
  const career = profile.careerStart !== null ? <>{profile.careerStart} – {profile.careerEnd ?? "현역"} <small>{profile.careerEnd !== null ? "· 은퇴" : `${Math.max(1, today.getFullYear() - profile.careerStart)}년차`}</small></> : profile.careerEnd !== null ? <>{profile.careerEnd} · 은퇴</> : null;
  if (!profile.birthDate && !profile.heightCm && !measurements && !profile.cup && !breast && !career) return null;
  return <dl className="av-profile__rows" aria-label="프로필">
    {profile.birthDate && <div><dt>생년월일</dt><dd>{birthLabel(profile.birthDate, today)}</dd></div>}
    {profile.heightCm !== null && <div><dt>키</dt><dd>{profile.heightCm} cm</dd></div>}
    {measurements && <div><dt>사이즈</dt><dd>{measurements}</dd></div>}
    {(profile.cup || breast) && <div><dt>가슴</dt><dd>{profile.cup && `${profile.cup}컵`} {breast && <span className="av-profile__pill">{breast}</span>}</dd></div>}
    {career && <div><dt>활동</dt><dd>{career}</dd></div>}
  </dl>;
}
export function ProfileLinks({ profile }: { profile: Profile }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  const seen = new Set<string>();
  const links = profile.urls.filter(link => {
    if (!safeProfileUrl(link.url)) return false;
    const normalized = new URL(link.url).href;
    if (seen.has(normalized)) return false;
    seen.add(normalized); return true;
  }).map(link => ({ ...link, ...linkInfo(link) })).sort((a, b) => a.priority - b.priority);
  if (!links.length) return null;
  return <><div className="av-profile__links" aria-label="배우 링크">
    {(expanded ? links : links.slice(0, 5)).map(link => <button key={link.url} type="button" onClick={() => { void openUrl(link.url).catch(() => setError(true)); }}>{link.label}</button>)}
    {!expanded && links.length > 5 && <button type="button" aria-expanded={false} aria-label={`링크 ${links.length - 5}개 더 보기`} onClick={() => setExpanded(true)}>+{links.length - 5}</button>}
  </div>{error && <p className="av-profile__quiet" role="status">링크를 열지 못했습니다.</p>}</>;
}

export function AvPerformerProfile({ personId, api, onOpenSettings, displayName, nameJa }: { displayName?: string; nameJa?: string | null; personId: string; api: AvGateway; onOpenSettings?: () => void }) {
  const { privacyMode } = usePrivacy();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AvProfileCandidate[] | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    let active = true;
    setProfile(null); setConfigured(null); setCandidates(null); setError(null); setBusy(false);
    const stored = api.getPerformerProfile(personId).then(value => { if (active && current === request.current) setProfile(value); }).catch(() => { if (active && current === request.current) setError("StashDB 프로필을 불러오지 못했습니다."); });
    const status = api.getStashdbCredentialStatus().then(value => { if (active) setConfigured(value.configured); return value.configured; });
    void Promise.all([stored, status]).then(async ([, hasKey]) => {
      if (!active || current !== request.current || !hasKey) return;
      setBusy(true);
      const value = await api.refreshPerformerProfile(personId, false);
      if (active && current === request.current) { setProfile(value); setError(null); }
    }).catch(() => { if (active && current === request.current) setError("StashDB 정보를 확인하지 못했습니다. 다시 시도해 주세요."); })
      .finally(() => { if (active && current === request.current) setBusy(false); });
    return () => { active = false; request.current++; };
  }, [api, personId]);

  async function refresh(chooser = false) {
    if (busy) return;
    const current = ++request.current;
    setBusy(true); setError(null);
    try {
      const next = chooser ? await api.searchPerformerProfile(personId) : await api.refreshPerformerProfile(personId, true);
      if (current !== request.current) return;
      if (chooser) setCandidates(next?.candidates ?? []); else setProfile(next);
    } catch { if (current === request.current) setError("StashDB 정보를 확인하지 못했습니다. 다시 시도해 주세요."); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function choose(id: string | null) {
    if (busy) return;
    const current = ++request.current;
    setBusy(true); setError(null);
    try {
      const next = id ? await api.choosePerformerProfile(personId, id) : await api.dismissPerformerProfile(personId);
      if (current === request.current) { setProfile(next); setCandidates(null); }
    } catch { if (current === request.current) setError("StashDB 연결을 저장하지 못했습니다."); }
    finally { if (current === request.current) setBusy(false); }
  }
  if (configured === false) return <p className="av-profile__quiet">StashDB 키가 없어요 · <button type="button" onClick={onOpenSettings}>설정</button></p>;
  const aliases = [...new Set([profile?.name, ...(profile?.aliases ?? [])].filter((name): name is string => Boolean(name?.trim())).map(name => name.trim()))].filter(name => name !== displayName && name !== nameJa);
  const checked = profile ? Date.parse(profile.fetchedAt) : NaN;
  const days = Number.isFinite(checked) ? Math.max(0, Math.floor((Date.now() - checked) / 86400000)) : 0;
  return <div className="av-profile" aria-busy={busy}>
    {profile?.status === "matched" && <>
      {aliases.length > 0 && <p className="av-profile__aliases">{aliases.slice(0, 3).join(" · ")}</p>}
      <ProfileRows profile={profile} />
      <ProfileLinks key={`${personId}:${profile.stashdbId}`} profile={profile} />
      <div className="av-profile__footer"><span>StashDB · {days}일 전 확인</span><button type="button" disabled={busy} aria-label="StashDB 새로고침" onClick={() => void refresh()}><ArrowPathIcon className={busy ? "av-profile__spinning" : ""} aria-hidden="true" /></button></div>
      <button type="button" className="av-profile__change" disabled={busy} onClick={() => void refresh(true)}>다른 사람으로 바꾸기</button>
    </>}
    {profile?.status === "ambiguous" && <p className="av-profile__quiet">StashDB에서 여러 명이 찾아졌어요 · <button type="button" disabled={busy} onClick={() => setCandidates(profile.candidates)}>고르기</button></p>}
    {profile?.status === "none" && <p className="av-profile__quiet">StashDB에서 못 찾았어요 · <button type="button" disabled={busy} onClick={() => void refresh()}>다시 찾기</button></p>}
    {!profile && busy && <p className="av-profile__quiet" role="status">StashDB 확인 중…</p>}
    {error && <p className="av-profile__quiet" role="status">{error} <button type="button" disabled={busy} onClick={() => void refresh()}>다시 시도</button></p>}
    {candidates !== null && <Dialog open title="StashDB 배우 고르기" onClose={() => { if (!busy) setCandidates(null); }}>
      <div className="av-profile__candidates">{candidates.map(candidate => <div className="av-profile__candidate" key={candidate.stashdbId}>
        {!privacyMode && candidate.imageUrl && safeProfileUrl(candidate.imageUrl) && <img src={candidate.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}
        <div><b>{candidate.name}</b><p>{candidate.aliases.join(" · ")}</p>{candidate.birthDate && <small>{candidate.birthDate.replace(/-/g, ".")}</small>}</div>
        <Button size="sm" disabled={busy} onClick={() => void choose(candidate.stashdbId)}>이 사람</Button>
      </div>)}{candidates.length === 0 && <p>검색 결과가 없어요.</p>}</div>
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button disabled={busy} onClick={() => setCandidates(null)}>취소</Button><Button disabled={busy} onClick={() => void choose(null)}>아무도 아님</Button></div>
    </Dialog>}
  </div>;
}
