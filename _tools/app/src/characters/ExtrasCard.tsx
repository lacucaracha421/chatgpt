import { useEffect, useRef, useState } from "react";
import { EllipsisHorizontalCircleIcon } from "@heroicons/react/24/outline";
import { characterExtrasApi, type ExtrasSuggestion } from "./extrasApi";
import { extrasTagName, strongestExtrasSuggestion } from "./extrasNames";
import "./CharacterExtras.css";

type SuggestionReader = Pick<typeof characterExtrasApi, "suggestions">;

/**
 * The promotion suggestions of one 기타. The shown list stays while a refresh is read (no flash),
 * and is replaced only when the 기타 changes or the new read lands.
 */
export function useExtrasSuggestions(targetId: string | null, version: number, api: SuggestionReader = characterExtrasApi) {
  const [read, setRead] = useState<{ targetId: string; rows: ExtrasSuggestion[] } | null>(null);
  useEffect(() => {
    if (!targetId) return;
    let active = true;
    void api.suggestions(targetId).then(rows => { if (active) setRead({ targetId, rows }); }, () => { if (active) setRead({ targetId, rows: [] }); });
    return () => { active = false; };
  }, [api, targetId, version]);
  return targetId && read?.targetId === targetId ? read.rows : [];
}

/** "<한국어 이름> N장 · 캐릭터로": the one line a 기타 card shows for its strongest suggestion, as the name and the rest. */
export function extrasSuggestionParts(suggestion: ExtrasSuggestion) {
  return { name: extrasTagName(suggestion.tag).name, rest: ` ${suggestion.imageCount.toLocaleString("ko-KR")}장 · 캐릭터로` };
}

export function extrasSuggestionLine(suggestion: ExtrasSuggestion) {
  const { name, rest } = extrasSuggestionParts(suggestion);
  return `${name}${rest}`;
}

/**
 * The 기타 card: always the last character card of a series or group. A dashed mosaic says "no name
 * yet"; when the automatic tags read one name on five or more of its images, one line offers 캐릭터로.
 */
export function ExtrasCard({ count, suggestions = [], onOpen, onPromote }: {
  count?: number;
  suggestions?: readonly ExtrasSuggestion[];
  onOpen: () => void;
  /** Opens the 기타 with this suggestion's images selected. */
  onPromote: (suggestion: ExtrasSuggestion) => void;
}) {
  const suggestion = strongestExtrasSuggestion(suggestions);
  // Eases in when the line first appears; a changed line replaces its text in place.
  const [shown, setShown] = useState(false);
  const wasShown = useRef(false);
  useEffect(() => {
    if (!suggestion) { wasShown.current = false; setShown(false); return; }
    if (wasShown.current) { setShown(true); return; }
    wasShown.current = true;
    const frame = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(frame);
  }, [Boolean(suggestion)]);
  return <article className="series-character folder-shelf__card series-character--extras">
    <button type="button" className="series-character__open" aria-label="기타 열기" aria-description="아직 이름 없는 사람의 이미지" onClick={onOpen}>
      <span className="character-extras-card__mosaic" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <span key={index} />)}</span>
      <strong><EllipsisHorizontalCircleIcon className="folder-shelf__icon" aria-hidden="true" /><span className="series-character__name">기타</span></strong>
      <small className="folder-shelf__meta" aria-hidden={count === undefined || undefined}>{count === undefined ? null : `${count.toLocaleString("ko-KR")}장`}</small>
    </button>
    {suggestion && <span className="character-extras-card__hint-frame">
      <button type="button" className="character-extras-card__hint" data-shown={shown || undefined} aria-label={`${extrasTagName(suggestion.tag).name} ${suggestion.imageCount.toLocaleString("ko-KR")}장 캐릭터로`}
        onClick={() => onPromote(suggestion)}>
        {/* A long name is shortened with an ellipsis; the count and 캐릭터로 always stay readable. */}
        <span className="character-extras-card__hint-name">{extrasSuggestionParts(suggestion).name}</span><span className="character-extras-card__hint-rest">{extrasSuggestionParts(suggestion).rest}</span>
      </button>
    </span>}
  </article>;
}
