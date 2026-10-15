import { SectionLabel } from "../shared/ui/SectionLabel";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { AssetImage } from "../privacy/AssetImage";
import { CharacterSuggestionsOverview } from "./suggestions/CharacterSuggestions";
import { ArrowLeftIcon, ChevronRightIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import { ViewToolbar } from "../layout/ViewToolbar";
import { commandErrorMessage } from "../library/errorMessage";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { Button } from "../shared/ui/Button";
import type { CharacterTarget } from "./api";
import { confirmSources, readConfirmItems, type ConfirmScope, type ConfirmSources } from "./confirmClient";
import { CONFIRM_KINDS, confirmGroups, confirmKindLabel, emptyConfirmCounts, tallyConfirm, type ConfirmCharacter, type ConfirmCounts, type ConfirmGroup, type ConfirmKind, type ConfirmTally } from "./confirmModel";
import "../home/characterReview.css";

type Props = {
  targets: readonly CharacterTarget[];
  seriesName: (id: string) => string | undefined;
  /** Moves when a review closes; the counts are read again. */
  version: number;
  /** Lightweight mode: the full read is skipped. */
  restricted: boolean;
  privacyMode: boolean;
  onBack: () => void;
  onOpen: (scope: ConfirmScope) => void;
  sources?: ConfirmSources;
};

const ALL = "\u0000all";
const seriesKey = (group: ConfirmGroup) => group.seriesId ?? "";

/**
 * 확인 overview, opened from Home: every pending item counted per series and character with its kinds
 * (태그 추천 · 인식 추천 · 다시 확인), each row opening that scope's list. Back returns to Home.
 */
export function ConfirmOverview({ targets, seriesName, version, restricted, privacyMode, onBack, onOpen, sources = confirmSources }: Props) {
  useBackHandler(onBack, 50);
  const [tallies, setTallies] = useState<ConfirmTally[] | null>(null);
  const [foldedTallies, setFoldedTallies] = useState<ConfirmTally[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [reading, setReading] = useState(false);
  const [unread, setUnread] = useState<ConfirmKind[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(ALL);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    if (restricted) return;
    let live = true;
    setReading(true); setError(null);
    readConfirmItems(sources, {}, targetsRef.current, () => live).then(read => {
      if (!live || !read) return;
      if (read.failed.length === CONFIRM_KINDS.length) { setError("확인 목록을 읽지 못했습니다."); return; }
      setTallies(tallyConfirm(read.items)); setFoldedTallies(tallyConfirm(read.folded)); setUnread(read.failed);
    }, (e: unknown) => {
      if (live) setError(commandErrorMessage(e, "확인 목록을 읽지 못했습니다."));
    }).finally(() => { if (live) setReading(false); });
    return () => { live = false; };
  }, [sources, restricted, version, retry]);

  const groups = useMemo(() => tallies ? confirmGroups(tallies, targets, seriesName, foldedTallies) : [], [tallies, foldedTallies, targets, seriesName]);
  // Series that only have folded characters are listed under their name but hold nothing to count.
  const counted = useMemo(() => groups.filter(group => group.counts.total > 0), [groups]);
  const totals = useMemo(() => groups.reduce((sum, group) => {
    for (const kind of CONFIRM_KINDS) sum[kind] += group.counts[kind];
    sum.total += group.counts.total;
    return sum;
  }, emptyConfirmCounts()), [groups]);
  const current = groups.find(group => seriesKey(group) === selected);
  // A series that emptied out after a review falls back to 전체.
  const shown = current ? [current] : groups;

  const index = <nav className="crv-index" aria-label="확인 시리즈">
    {!restricted && suggestionCount > 0 && <>
      <SectionLabel as="h2" className="workspace-section-label" title="제안" />
      <IndexRow label="새 캐릭터 제안" count={suggestionCount} current={false} onClick={() => document.getElementById("new-character-suggestions")?.scrollIntoView({ block: "start" })} />
    </>}
    {counted.length > 0 && !restricted && <>
      <SectionLabel as="h2" className="workspace-section-label" title="시리즈" />
      <IndexRow label="전체" count={totals.total} current={!current} onClick={() => setSelected(ALL)} />
      {counted.map(group => <IndexRow key={seriesKey(group)} label={group.seriesName} count={group.counts.total} current={current === group}
        onClick={() => setSelected(seriesKey(group))} />)}
    </>}
  </nav>;

  let body;
  if (restricted) {
    body = <div className="crv-notice" role="status">
      <p><b>절약 모드</b>에서는 확인 목록 전체를 읽지 않아 시리즈 · 캐릭터별로 나누어 보여 주지 않습니다. 절약 모드를 끄면 바로 셉니다.</p>
      <Button size="sm" onClick={() => onOpen({})}>전체 확인</Button>
    </div>;
  } else if (error) {
    body = <div className="crv-notice" role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry(value => value + 1)}>다시 시도</Button></div>;
  } else if (!tallies) {
    body = null;
  } else if (groups.length === 0) {
    body = <div className="crv-notice" role="status"><p>확인할 항목이 없습니다.</p></div>;
  } else {
    body = <>
      {unread.length > 0 && <div className="crv-notice" role="status"><p>{unread.map(kind => confirmKindLabel[kind]).join(" · ")} 목록은 읽지 못해 세지 않았습니다.</p><Button size="sm" onClick={() => setRetry(value => value + 1)}>다시 시도</Button></div>}
      <div className="crv-groups" aria-busy={reading || undefined}>
        {shown.map(group => <section key={seriesKey(group)} className="crv-group" aria-label={group.seriesName}>
          <header className="crv-group__head">
            <h3>{group.seriesName}</h3>
            <span className="crv-count numeric">{group.counts.total.toLocaleString()}<small>건</small></span>
            <Split counts={group.counts} />
            <span className="crv-space" />
            {group.seriesId && group.counts.total > 0 && <Button size="sm" variant="ghost" className="crv-group__open" aria-label={`${group.seriesName} 전체 확인 ${group.counts.total}건`}
              onClick={() => onOpen({ series: { id: group.seriesId!, name: group.seriesName } })}>시리즈 전체 확인<ChevronRightIcon aria-hidden="true" /></Button>}
          </header>
          <div className="crv-characters">
            {group.characters.map(character => <CharacterRow key={character.targetId} group={group} character={character} privacyMode={privacyMode} onOpen={onOpen} />)}
          </div>
          {group.folded.length > 0 && <FoldedCharacters group={group} privacyMode={privacyMode} open={expanded.has(seriesKey(group))} onOpen={onOpen}
            onToggle={() => setExpanded(previous => { const next = new Set(previous); if (!next.delete(seriesKey(group))) next.add(seriesKey(group)); return next; })} />}
        </section>)}
      </div>
    </>;
  }

  return <div className="crv-view">
    <ViewToolbar title="확인"
      leadingAction={<Button size="icon" variant="ghost" aria-label="홈으로 돌아가기" onClick={onBack}><ArrowLeftIcon aria-hidden="true" /></Button>}
      chrome={{ navigation: index }} />
    <div className="crv-scroll">
      <div className="crv-page">
        {!restricted && <CharacterSuggestionsOverview version={version} privacyMode={privacyMode} onCount={setSuggestionCount} onSaved={() => setRetry(value => value + 1)} />}
        {tallies && !restricted && !error && counted.length > 0 && <div className="crv-summary">
          <span className="crv-count crv-count--lg numeric">{totals.total.toLocaleString()}<small>건</small></span>
          <span className="crv-summary__t">{counted.length.toLocaleString()}개 시리즈 · {counted.reduce((sum, group) => sum + group.characters.length, 0).toLocaleString()}명
            <Split counts={totals} /></span>
          <span className="crv-space" />
          <Button size="sm" onClick={() => onOpen({})}>전체 확인</Button>
        </div>}
        <BusyLabel busy={!restricted && !error && tallies === null && reading} delay={400}><p className="crv-reading" role="status">확인 목록 읽는 중</p></BusyLabel>
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

function Split({ counts }: { counts: ConfirmCounts }) {
  const kinds = CONFIRM_KINDS.filter(kind => counts[kind] > 0);
  if (kinds.length === 0) return null;
  return <span className="crv-split">
    {kinds.map((kind, position) => <span key={kind}>
      {position > 0 && <span aria-hidden="true"> · </span>}{confirmKindLabel[kind]} <span className="numeric">{counts[kind].toLocaleString()}</span>
    </span>)}
  </span>;
}

function CharacterRow({ group, character, privacyMode, onOpen }: { group: ConfirmGroup; character: ConfirmCharacter; privacyMode: boolean; onOpen: (scope: ConfirmScope) => void }) {
  return <button type="button" className="crv-character" aria-label={`${group.seriesName} › ${character.name} 확인 ${character.counts.total}건`}
    onClick={() => onOpen({ ...(group.seriesId ? { series: { id: group.seriesId, name: group.seriesName } } : {}), target: { id: character.targetId, name: character.name } })}>
    <span className="crv-portrait" aria-hidden="true">
      {character.thumbnailAssetId && !privacyMode ? <AssetImage src={thumbnailUrl(character.thumbnailAssetId)} alt="" loading="lazy" decoding="async" /> : <UserIcon />}
    </span>
    <span className="crv-character__t"><b>{character.name}</b><Split counts={character.counts} /></span>
    <span className="crv-count numeric">{character.counts.total.toLocaleString()}<small>건</small></span>
    <ChevronRightIcon className="crv-chevron" aria-hidden="true" />
  </button>;
}

/**
 * 인식 추천 of characters still far from switching to 학습 인식: kept out of the counts, one step away.
 * Opening a character here lists everything it has, folded items included.
 */
function FoldedCharacters({ group, privacyMode, open, onToggle, onOpen }: { group: ConfirmGroup; privacyMode: boolean; open: boolean; onToggle: () => void; onOpen: (scope: ConfirmScope) => void }) {
  return <div className="crv-folded">
    <Button size="sm" variant="ghost" className="crv-folded__toggle" aria-expanded={open} onClick={onToggle}>
      {open ? "접기" : `더 보기 (${group.folded.length.toLocaleString()}명)`}
    </Button>
    {open && <div className="crv-characters" aria-label={`${group.seriesName} 더 보기`}>
      {group.folded.map(character => <CharacterRow key={character.targetId} group={group} character={character} privacyMode={privacyMode} onOpen={onOpen} />)}
    </div>}
  </div>;
}
