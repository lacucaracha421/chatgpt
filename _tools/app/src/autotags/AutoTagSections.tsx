import { EmptyState } from "../shared/ui/EmptyState";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { Toast } from "../shared/ui/Toast";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { applyAutoTagFilter, useAutoTagFilter } from "./autoTagFilter";
import { autoTagEnglish, buildAutoTagView, characterSeries, searchAutoTags, type AutoTagChip, type AutoTagView } from "./autoTagModel";
import { invalidateAutoTagVocabulary, useAutoTagVocabulary, type AutoTagVocabulary } from "./autoTagVocabulary";
import type { AssetAutoTags, AutoTagEdit, AutoTagGateway } from "./types";
import "./autoTags.css";

type Undo = { message: string; assetId: string; tag: string; edit: AutoTagEdit };

export type AssetAutoTagState = {
  gateway: AutoTagGateway;
  assetId: string;
  view: AutoTagView;
  vocabulary: AutoTagVocabulary | null;
  remove: (chip: AutoTagChip) => void;
  add: (tag: string) => void;
  /** Applies the tag as an 에셋 filter. */
  filter: (tag: string) => void;
};

/**
 * Loads one asset's 자동 태그 and owns its edits (✕ with undo, + 태그 추가). Null while there is
 * nothing to show: no gateway, no asset, or no tagger output and no user tags.
 */
export function useAssetAutoTags(gateway: AutoTagGateway | undefined, assetId: string | null, onFilterApplied?: () => void) {
  const [result, setResult] = useState<{ assetId: string; tags: AssetAutoTags } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  useAutoDismiss(undo?.message ?? null, useCallback(() => setUndo(null), []));
  useAutoDismiss(error, setError);
  const vocabulary = useAutoTagVocabulary(gateway, Boolean(assetId));

  useEffect(() => {
    let active = true;
    if (!gateway || !assetId) { setResult(null); return () => { active = false; }; }
    void gateway.assetTags(assetId)
      .then((tags) => { if (active) setResult({ assetId, tags }); })
      .catch(() => { if (active) setResult(null); });
    return () => { active = false; };
  }, [assetId, gateway, reloadVersion]);
  useEffect(() => { setUndo(null); }, [assetId]);

  const current = result && result.assetId === assetId ? result.tags : null;
  const view = useMemo(() => current ? buildAutoTagView(current) : null, [current]);

  const run = async (targetAssetId: string, tag: string, edit: AutoTagEdit) => {
    if (!gateway) return false;
    try {
      await gateway.edit(targetAssetId, tag, edit);
      invalidateAutoTagVocabulary();
      return true;
    } catch (reason) {
      setError(commandErrorMessage(reason, "자동 태그를 바꾸지 못했습니다."));
      return false;
    } finally {
      setReloadVersion((value) => value + 1);
    }
  };

  const state: AssetAutoTagState | null = gateway && assetId && view && (view.total > 0 || (vocabulary?.entries.length ?? 0) > 0) ? {
    gateway,
    assetId,
    view,
    vocabulary,
    remove: (chip) => {
      // Hide it at once; the reload after the edit settles the real state.
      setResult((previous) => previous && { ...previous, tags: { ...previous.tags, tags: previous.tags.tags.filter((tag) => tag.tag !== chip.tag) } });
      void run(assetId, chip.tag, "remove").then((done) => {
        if (done) setUndo({ message: `태그 1개 뺌 · ${chip.label}`, assetId, tag: chip.tag, edit: chip.source === "added" ? "add" : "reset" });
      });
    },
    add: (tag) => { setUndo(null); void run(assetId, tag, "add"); },
    filter: (tag) => {
      if (applyAutoTagFilter(tag)) onFilterApplied?.();
      else setError("자동 태그 필터는 8개까지 쓸 수 있습니다.");
    },
  } : null;

  const notices = <>
    {undo && <Toast actionLabel="되돌리기" onAction={() => { const pending = undo; setUndo(null); void run(pending.assetId, pending.tag, pending.edit); }} onDismiss={() => setUndo(null)}>{undo.message}</Toast>}
    {error && <Toast tone="error" onDismiss={() => setError(null)}>{error}</Toast>}
  </>;
  return { state, notices };
}

function countText(vocabulary: AutoTagVocabulary | null, tag: string) {
  const count = vocabulary?.byTag.get(tag)?.count;
  return count === undefined ? null : `라이브러리 ${count.toLocaleString("ko-KR")}장`;
}

function chipLabel(chip: AutoTagChip) {
  if (chip.group !== "character") return chip.label;
  const series = characterSeries(chip.tag);
  return series ? `${chip.label} · ${series}` : chip.label;
}

function Chip({ chip, state, active, removable = true }: { chip: AutoTagChip; state: AssetAutoTagState; active: boolean; removable?: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const label = chipLabel(chip);
  const english = autoTagEnglish(chip.tag);
  const count = countText(state.vocabulary, chip.tag);
  const detail = [english, count].filter(Boolean).join(" · ");
  const className = ["auto-tag", chip.common && "auto-tag--common", chip.group === "character" && "auto-tag--character",
    chip.source === "added" && "auto-tag--added", active && "auto-tag--active"].filter(Boolean).join(" ");
  return <span className={className}>
    <button type="button" className="auto-tag__label" aria-description={detail || undefined} aria-expanded={detailsOpen} aria-pressed={active}
      onClick={() => setDetailsOpen((open) => !open)}>
      {label}{chip.guessed && <span className="auto-tag__guess">추정</span>}
    </button>
    {removable && <button type="button" className="auto-tag__remove" aria-label={`${label} 태그 빼기`} onClick={() => state.remove(chip)}><XMarkIcon aria-hidden="true" /></button>}
    {detailsOpen && <span className="auto-tag__card"><span lang="en">{english}</span>{count && <small>{count}</small>}<button type="button" onClick={() => state.filter(chip.tag)}>이 태그로 찾기</button></span>}
  </span>;
}

/** 주요 태그: the guessed character chips above 출처; nothing when no character qualifies. */
export function AutoTagHighlights({ state }: { state: AssetAutoTagState | null }) {
  const filter = useAutoTagFilter();
  if (!state || state.view.characters.length === 0) return null;
  return <section className="asset-inspector__section auto-tags auto-tags--highlights" aria-label="주요 태그">
    <SectionLabel as="h3" title="주요 태그" />
    <div className="auto-tags__chips">
      {state.view.characters.map((chip) => <Chip key={chip.tag} chip={chip} state={state} active={filter.include.includes(chip.tag)} removable={false} />)}
    </div>
  </section>;
}

/** 자동 태그: every tag grouped by kind, with ✕ to remove and + 태그 추가. */
export function AutoTagList({ state }: { state: AssetAutoTagState | null }) {
  const filter = useAutoTagFilter();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  // Closed by default; the choice stays while moving between assets.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setAdding(false); }, [state?.assetId]);
  if (!state) return null;
  const toggle = (key: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return <section className="asset-inspector__section auto-tags" aria-label="자동 태그">
    <div className="auto-tags__heading">
      <h3><button type="button" className="auto-tags__toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}자동 태그 <span className="auto-tags__count">{state.view.total.toLocaleString("ko-KR")}</span></button></h3>
      {expanded && !adding && (state.vocabulary?.entries.length ?? 0) > 0 && <button type="button" className="auto-tags__add" onClick={() => setAdding(true)}><PlusIcon aria-hidden="true" />태그 추가</button>}
    </div>
    {expanded && adding && <AutoTagAdder state={state} onClose={() => setAdding(false)} />}
    {expanded && state.view.groups.map((group) => {
      const open = !collapsed.has(group.key);
      return <div key={group.key} className="auto-tags__group">
        <button type="button" className="auto-tags__group-label" aria-expanded={open} onClick={() => toggle(group.key)}>
          {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}{group.label}<span className="auto-tags__count">{group.chips.length}</span>
        </button>
        {open && <div className="auto-tags__chips">
          {group.chips.map((chip) => <Chip key={chip.tag} chip={chip} state={state} active={filter.include.includes(chip.tag)} />)}
        </div>}
      </div>;
    })}
  </section>;
}

function AutoTagAdder({ state, onClose }: { state: AssetAutoTagState; onClose: () => void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const present = useMemo(() => new Set(state.view.groups.flatMap((group) => group.chips.map((chip) => chip.tag))), [state.view]);
  const matches = useMemo(() => searchAutoTags(state.vocabulary?.entries ?? [], text, { limit: 6 }).filter((entry) => !present.has(entry.tag)), [present, state.vocabulary, text]);
  useEffect(() => { input.current?.focus(); }, []);
  const choose = (tag: string | undefined) => {
    if (!tag) return;
    state.add(tag);
    setText("");
    setActive(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      // Close the field only; the inspector stays open.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length) setActive((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(matches[Math.min(active, matches.length - 1)]?.tag);
    }
  };
  return <div className="auto-tags__adder">
    <div className="auto-tags__field">
      <PlusIcon aria-hidden="true" />
      <input ref={input} type="text" role="combobox" aria-label="추가할 태그 (한국어 또는 영어)" aria-expanded={matches.length > 0} aria-controls={`${id}-list`}
        aria-autocomplete="list" aria-activedescendant={matches.length ? `${id}-${Math.min(active, matches.length - 1)}` : undefined}
        value={text} spellCheck={false} autoComplete="off" placeholder="태그 이름"
        onChange={(event) => { setText(event.target.value); setActive(0); }} onKeyDown={onKeyDown} onBlur={() => { if (!text) onClose(); }} />
      <button type="button" className="auto-tags__field-close" aria-label="태그 추가 닫기" onMouseDown={(event) => event.preventDefault()} onClick={onClose}><XMarkIcon aria-hidden="true" /></button>
    </div>
    {matches.length > 0 && <div id={`${id}-list`} role="listbox" aria-label="맞는 태그" className="auto-tags__matches">
      {matches.map((entry, index) => <div key={entry.tag} id={`${id}-${index}`} role="option" aria-selected={index === Math.min(active, matches.length - 1)}
        className="auto-tags__match" onPointerMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(entry.tag)}>
        <span>{entry.label}</span>
        {entry.label !== autoTagEnglish(entry.tag) && <span className="auto-tags__match-en" lang="en">{autoTagEnglish(entry.tag)}</span>}
        <span className="auto-tags__match-count">{entry.count.toLocaleString("ko-KR")}</span>
      </div>)}
    </div>}
    {text.trim() && matches.length === 0 && <EmptyState inline className="auto-tags__empty" title="검색 결과 없음" />}
  </div>;
}
