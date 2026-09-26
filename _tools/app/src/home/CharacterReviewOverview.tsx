import { ChevronLeftIcon, ChevronRightIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import { ViewToolbar } from "../layout/ViewToolbar";
import { commandErrorMessage } from "../library/errorMessage";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { Button } from "../shared/ui/Button";
import type { CharacterReviewProgress, CharacterReviewSource } from "./characterReviewSource";
import { characterReviewGroups, type CharacterReviewCharacter, type CharacterReviewGroup, type CharacterReviewTally } from "./homeModel";
import "./characterReview.css";

type Scope = { id: string; name: string };
export type CharacterReviewScope = { series?: Scope; target?: Scope };
type ReviewTarget = Parameters<typeof characterReviewGroups>[1][number];

type Props = {
  source: CharacterReviewSource;
  targets: readonly ReviewTarget[];
  seriesName: (id: string) => string | undefined;
  /** Moves when a review closes; the counts are read again. */
  version: number;
  /** Lightweight mode: the full candidate read is skipped. */
  restricted: boolean;
  privacyMode: boolean;
  onBack: () => void;
  onOpen: (scope: CharacterReviewScope) => void;
};

const ALL = "\u0000all";
const seriesKey = (group: CharacterReviewGroup) => group.seriesId ?? "";

/**
 * 캐릭터 검토 overview: every pending S36 candidate counted per series and character (the
 * whole list, exact), each row opening that scope's review. Back returns to Home.
 */
export function CharacterReviewOverview({ source, targets, seriesName, version, restricted, privacyMode, onBack, onOpen }: Props) {
  useBackHandler(onBack, 50);
  const [tallies, setTallies] = useState<CharacterReviewTally[] | null>(null);
  const [progress, setProgress] = useState<CharacterReviewProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(ALL);

  useEffect(() => {
    if (restricted) return;
    let live = true;
    setProgress({ read: 0, total: null }); setError(null);
    source((value) => { if (live) setProgress(value); }, () => live).then((value) => {
      if (!live || !value) return;
      setTallies(value); setProgress(null);
    }, (e: unknown) => {
      if (!live) return;
      setError(commandErrorMessage(e, "캐릭터 검토 목록을 읽지 못했습니다.")); setProgress(null);
    });
    return () => { live = false; };
  }, [source, restricted, version, retry]);

  const groups = useMemo(() => tallies ? characterReviewGroups(tallies, targets, seriesName) : [], [tallies, targets, seriesName]);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const current = groups.find((group) => seriesKey(group) === selected);
  // A series that emptied out after a review falls back to 전체.
  const shown = current ? [current] : groups;
  const reading = progress !== null;

  const index = <nav className="crv-index" aria-label="캐릭터 검토 시리즈">
    {groups.length > 0 && !restricted && <>
      <h2 className="workspace-section-label">시리즈</h2>
      <IndexRow label="전체" count={total} current={!current} onClick={() => setSelected(ALL)} />
      {groups.map((group) => <IndexRow key={seriesKey(group)} label={group.seriesName} count={group.total} current={current === group}
        onClick={() => setSelected(seriesKey(group))} />)}
    </>}
  </nav>;

  let body;
  if (restricted) {
    body = <div className="crv-notice" role="status">
      <p><b>가벼운 모드</b>에서는 후보 목록 전체를 읽지 않아 시리즈 · 캐릭터별로 나누어 보여 주지 않습니다. 가벼운 모드를 끄면 바로 셉니다.</p>
      <Button size="sm" onClick={() => onOpen({})}>전체 후보 검토</Button>
    </div>;
  } else if (error) {
    body = <div className="crv-notice" role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry((value) => value + 1)}>다시 시도</Button></div>;
  } else if (!tallies) {
    body = <Reading progress={progress} />;
  } else if (groups.length === 0) {
    body = <div className="crv-notice" role="status"><p>확인할 후보가 없습니다.</p></div>;
  } else {
    body = <>
      {reading && <Reading progress={progress} again />}
      <div className="crv-groups" aria-busy={reading || undefined}>
        {shown.map((group) => <section key={seriesKey(group)} className="crv-group" aria-label={group.seriesName}>
          <header className="crv-group__head">
            <h3>{group.seriesName}</h3>
            <span className="crv-count numeric">{group.total.toLocaleString()}<small>건</small></span>
            <Split automatic={group.automatic} recommended={group.recommended} />
            <span className="crv-space" />
            {group.seriesId && <Button size="sm" variant="ghost" className="crv-group__open" aria-label={`${group.seriesName} 전체 검토 ${group.total}건`}
              onClick={() => onOpen({ series: { id: group.seriesId!, name: group.seriesName } })}>시리즈 전체 검토<ChevronRightIcon aria-hidden="true" /></Button>}
          </header>
          <div className="crv-characters">
            {group.characters.map((character) => <CharacterRow key={character.targetId} group={group} character={character} privacyMode={privacyMode} onOpen={onOpen} />)}
          </div>
        </section>)}
      </div>
    </>;
  }

  return <div className="crv-view">
    <ViewToolbar title="캐릭터 검토"
      leadingAction={<Button size="icon" variant="ghost" aria-label="홈으로 돌아가기" onClick={onBack}><ChevronLeftIcon aria-hidden="true" /></Button>}
      chrome={{ navigation: index }} />
    <div className="crv-scroll">
      <div className="crv-page">
        {tallies && !restricted && !error && groups.length > 0 && <div className="crv-summary">
          <span className="crv-count crv-count--lg numeric">{total.toLocaleString()}<small>건</small></span>
          <span className="crv-summary__t">{groups.length.toLocaleString()}개 시리즈 · {groups.reduce((sum, group) => sum + group.characters.length, 0).toLocaleString()}명
            <Split automatic={groups.reduce((sum, group) => sum + group.automatic, 0)} recommended={groups.reduce((sum, group) => sum + group.recommended, 0)} /></span>
          <span className="crv-space" />
          <Button size="sm" onClick={() => onOpen({})}>전체 검토</Button>
        </div>}
        {body}
      </div>
    </div>
  </div>;
}

function IndexRow({ label, count, current, onClick }: { label: string; count: number; current: boolean; onClick: () => void }) {
  return <button type="button" className="workspace-index-link crv-index__row" aria-current={current ? "page" : undefined} onClick={onClick}>
    <span className="crv-index__label">{label}</span><span className="crv-index__count numeric">{count.toLocaleString()}</span>
  </button>;
}

function Split({ automatic, recommended }: { automatic: number; recommended: number }) {
  if (!automatic && !recommended) return null;
  return <span className="crv-split">
    {automatic > 0 && <span>자동 <span className="numeric">{automatic.toLocaleString()}</span></span>}
    {automatic > 0 && recommended > 0 && <span aria-hidden="true"> · </span>}
    {recommended > 0 && <span>추천 <span className="numeric">{recommended.toLocaleString()}</span></span>}
  </span>;
}

function CharacterRow({ group, character, privacyMode, onOpen }: { group: CharacterReviewGroup; character: CharacterReviewCharacter; privacyMode: boolean; onOpen: (scope: CharacterReviewScope) => void }) {
  return <button type="button" className="crv-character" aria-label={`${group.seriesName} › ${character.name} 검토 ${character.count}건`}
    onClick={() => onOpen({ ...(group.seriesId ? { series: { id: group.seriesId, name: group.seriesName } } : {}), target: { id: character.targetId, name: character.name } })}>
    <span className="crv-portrait" aria-hidden="true">
      {character.thumbnailAssetId && !privacyMode ? <img src={thumbnailUrl(character.thumbnailAssetId)} alt="" loading="lazy" decoding="async" /> : <UserIcon />}
    </span>
    <span className="crv-character__t"><b>{character.name}</b><Split automatic={character.automatic} recommended={character.recommended} /></span>
    <span className="crv-count numeric">{character.count.toLocaleString()}<small>건</small></span>
    <ChevronRightIcon className="crv-chevron" aria-hidden="true" />
  </button>;
}

function Reading({ progress, again = false }: { progress: CharacterReviewProgress | null; again?: boolean }) {
  const read = progress?.read ?? 0;
  const total = progress?.total ?? null;
  return <div className="crv-reading" role="status">
    <span>{again ? "다시 세는 중" : "후보 목록 읽는 중"}{total !== null && <> · <span className="numeric">{read.toLocaleString()}</span> / <span className="numeric">{total.toLocaleString()}</span>건</>}</span>
    {total !== null && total > 0 && <span className="crv-progress" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((read / total) * 100))}%` }} /></span>}
  </div>;
}
