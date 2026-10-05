import { BusyLabel } from "../../shared/ui/BusyLabel";
import { AssetImage } from "../../privacy/AssetImage";
import { useHorizontalWheel } from "../../shared/ui/useHorizontalWheel";
import { useEffect, useRef, useState } from "react";
import { assetUrl, thumbnailUrl } from "../../assets/mediaUrl";
import { commandErrorMessage } from "../../library/errorMessage";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { TextField } from "../../shared/ui/TextField";
import type { CharacterGroup } from "../hubApi";
import { folderPath, suggestionName, type Suggestion, type SuggestionApi, type SuggestionContext, type SuggestionDetail, type SuggestionImage, type SuggestionResult } from "./client";

export function SuggestionDialog({ suggestion, mode, privacyMode, api, onClose, onSaved }: {
  suggestion: Suggestion; mode: "register" | "merge"; privacyMode: boolean; api: SuggestionApi;
  onClose(): void; onSaved(result: SuggestionResult): void;
}) {
  const stripWheel = useHorizontalWheel();
  const [context, setContext] = useState<SuggestionContext | null>(null);
  const [name, setName] = useState(suggestionName(suggestion.tag));
  const [seriesId, setSeriesId] = useState(suggestion.seriesId ?? "");
  const [targetId, setTargetId] = useState("");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<CharacterGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [detail, setDetail] = useState<SuggestionDetail | null>(null);
  const [references, setReferences] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [includeOutside, setIncludeOutside] = useState(true);
  const [linkTag, setLinkTag] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const saving = useRef(false);
  const target = context?.targets.find(item => item.id === targetId);
  const chosenSeries = mode === "merge" ? target?.seriesClassificationId ?? null : seriesId || null;
  useEffect(() => {
    let live = true;
    void api.context().then(value => { if (live) setContext(value); }, reason => {
      if (live) setError(commandErrorMessage(reason, "폴더와 캐릭터를 불러오지 못했습니다."));
    });
    return () => { live = false; };
  }, [api, retry]);
  useEffect(() => {
    let live = true;
    setDetail(null); setReferences([]); setPreviewId(null); setGroups([]); setGroupId(""); setError(null);
    if (!chosenSeries) return;
    void Promise.all([api.detail(suggestion.tag, chosenSeries), mode === "register" ? api.groups(chosenSeries) : Promise.resolve([])]).then(([value, nextGroups]) => {
      if (!live) return;
      setDetail(value); setGroups(nextGroups); setReferences(mode === "register" ? value.referenceIds : []);
    }, reason => { if (live) setError(commandErrorMessage(reason, "제안을 불러오지 못했습니다.")); });
    return () => { live = false; };
  }, [api, suggestion.tag, chosenSeries, mode, retry]);

  const candidateImages = detail?.images.filter(image => !references.includes(image.assetId) && (includeOutside || image.insideSeries)) ?? [];
  const candidateCount = candidateImages.length;
  const insideImages = (detail?.images.filter(image => image.insideSeries) ?? []).sort((a, b) =>
    Number(b.solo) - Number(a.solo) || Math.max(b.pixaiScore, b.canaryScore) - Math.max(a.pixaiScore, a.canaryScore) || a.assetId.localeCompare(b.assetId));
  const replacements = insideImages.filter(image => !references.includes(image.assetId));
  const preview = insideImages.find(image => image.assetId === previewId);
  const movePreview = (delta: number) => {
    const index = insideImages.findIndex(image => image.assetId === previewId);
    setPreviewId(insideImages[(index + delta + insideImages.length) % insideImages.length].assetId);
  };
  const toggleReference = (image: SuggestionImage) => {
    if (busy || !image.insideSeries) return;
    setReferences(ids => ids.includes(image.assetId) ? ids.filter(id => id !== image.assetId) : ids.length < 8 ? [...ids, image.assetId] : ids);
  };
  async function save() {
    if (!detail || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const result = mode === "register" ? await api.register({
        tag: suggestion.tag, seriesId, displayName: name.trim(), previewToken: detail.previewToken,
        referenceIds: references, excludedAssetIds: [], includeOutside, linkTag,
        groupId: groupId || null, expectedGroupRevision: groups.find(group => group.id === groupId)?.revision ?? null,
      }) : target ? await api.merge({ tag: suggestion.tag, targetId: target.id, expectedFingerprint: target.fingerprint, previewToken: detail.previewToken, linkTag }) : null;
      if (result) onSaved(result);
    } catch (reason) { setError(commandErrorMessage(reason, "저장하지 못했습니다. 목록을 새로 불러온 뒤 다시 확인해 주세요.")); }
    finally { saving.current = false; setBusy(false); }
  }
  const selectDisabled = busy || !context;
  return <Dialog open title={mode === "register" ? "새 캐릭터 등록" : "같은 캐릭터 고르기"} variant={mode === "register" ? "workspace" : "medium"} onClose={() => { if (previewId) setPreviewId(null); else if (!busy) onClose(); }}>
    <div className="character-suggestion-dialog">
      <div className="character-suggestion-dialog__content" inert={preview ? true : undefined}>
      <header className="character-suggestion-dialog__head">
        <h2>{mode === "register" ? "새 캐릭터 등록" : "같은 캐릭터 고르기"}</h2>
        <p className="character-suggestion-tag">제안에서 · {suggestion.tag}</p>
      </header>
      <div className={mode === "register" ? "character-suggestion-dialog__columns" : "character-suggestion-dialog__merge"}>
        <div className="character-suggestion-dialog__settings">
          {mode === "register" ? <>
            <TextField label="이름" value={name} disabled={busy} onChange={event => setName(event.target.value)} />
            <small>이름을 고쳐도 태그 연결은 그대로예요.</small>
            <label className="character-suggestion-field">시리즈 폴더<select value={seriesId} disabled={selectDisabled} onChange={event => setSeriesId(event.target.value)}>
              <option value="">폴더를 골라 주세요</option>
              {context?.folders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(folder.id, context.folders)}</option>)}
            </select></label>
            <label className="character-suggestion-field">그룹<select value={groupId} disabled={busy || !detail} onChange={event => setGroupId(event.target.value)}>
              <option value="">없음</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select></label>
            <label><input type="checkbox" checked={includeOutside} disabled={busy} onChange={event => setIncludeOutside(event.target.checked)} /> 시리즈 폴더 밖 이미지도 후보로</label>
          </> : <>
            <TextField label="캐릭터 찾기" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
            <div className="character-suggestion-targets" role="radiogroup" aria-label="합칠 캐릭터">
              {context?.targets.filter(item => item.seriesClassificationId && item.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
                .sort((a, b) => Number(b.seriesClassificationId === suggestion.seriesId) - Number(a.seriesClassificationId === suggestion.seriesId))
                .map(item => <label key={item.id}><input type="radio" name="suggestion-target" checked={targetId === item.id} disabled={busy} onChange={() => setTargetId(item.id)} />
                  <span>{item.displayName}<small>{folderPath(item.seriesClassificationId!, context.folders)}</small></span>
                </label>)}
            </div>
          </>}
          <label><input type="checkbox" checked={linkTag} disabled={busy} onChange={event => setLinkTag(event.target.checked)} /> {mode === "register" ? "태그를 이 캐릭터에 연결" : "이 태그를 선택한 캐릭터로 기억"}</label>
          {!linkTag && <small>연결하지 않으면 이 태그가 다시 제안될 수 있어요.</small>}
          <p className="character-suggestion-note">{mode === "register" ? "참조는 시리즈 폴더 안에서만 고를 수 있어요. 단독 이미지를 먼저 골라 두었어요." : "후보는 태거 검토에서 확인해요. 바로 확정하지 않아요."}</p>
        </div>
        {mode === "register" && <div className="character-suggestion-dialog__images">
          {!chosenSeries && <p>참조 이미지를 고를 시리즈 폴더를 선택해 주세요.</p>}
          <BusyLabel busy={!!(chosenSeries && !detail && !error)}><p role="status">이미지 불러오는 중…</p></BusyLabel>
          {detail && <>
            <h3>참조 이미지 {references.length}<small>단독 우선 · 최대 8장</small></h3>
            <div ref={stripWheel} className="character-suggestion-references" role="group" aria-label="참조 이미지">
              {Array.from({ length: 8 }, (_, index) => {
                const id = references[index];
                const image = detail.images.find(item => item.assetId === id);
                return image ? <ImageChoice key={id} image={image} privacyMode={privacyMode} selected index={index + 1} disabled={busy} onClick={() => setPreviewId(id)} />
                  : <div key={`empty-${index}`} className="character-suggestion-reference-empty" aria-label={`빈 참조 슬롯 ${index + 1}`}><span>{index + 1}</span></div>;
              })}
            </div>
            {references.length < 5 && <p className="character-suggestion-warning">참조 5장 미만: 수동 관리로 시작해요.</p>}
            <h3>참조 바꾸기<small>눌러서 크게 보기 · 단독 우선</small></h3>
            <div className="character-suggestion-replacements" role="group" aria-label="참조 바꾸기">
              {replacements.map(image => <ImageChoice key={image.assetId} image={image} privacyMode={privacyMode} disabled={busy} onClick={() => setPreviewId(image.assetId)} />)}
              {!replacements.length && <p className="character-suggestion-tag">바꿀 참조 이미지가 없습니다.</p>}
            </div>
            <p className="character-suggestion-candidate-summary">검토 후보 {candidateCount}장 — 등록하면 두 태거와 자동 분류가 모두 맞다고 한 그림은 자동으로 확정하고, 나머지는 태거 검토로 보내요.</p>
          </>}
        </div>}
      </div>
      {error && <p role="alert">{error} <Button size="sm" disabled={busy} onClick={() => setRetry(value => value + 1)}>다시 시도</Button></p>}
      <div className="character-suggestion-dialog__footer">
        <p>{mode === "register" ? <>{name || "캐릭터"}를 만들고 참조 {references.length}장 · 검토 후보 {candidateCount}장</> : <>{target?.displayName ?? "캐릭터"}에 최대 {detail?.images.length ?? 0}장을 검토 후보로 넣어요. 기존 참조·판단은 유지해요.</>}</p>
        <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
        <Button variant="primary" disabled={busy || !detail || !context || (mode === "register" ? !name.trim() || !seriesId : !target)} onClick={() => void save()}><BusyLabel busy={!!(busy)} idle={mode === "register" ? "캐릭터 만들기" : "선택한 캐릭터에 합치기"}>저장 중…</BusyLabel></Button>
      </div>
      </div>
      {preview && <ImagePreview image={preview} privacyMode={privacyMode} selected={references.includes(preview.assetId)}
        canAdd={references.length < 8} onMove={movePreview} onToggle={() => toggleReference(preview)} onClose={() => setPreviewId(null)} />}
    </div>
  </Dialog>;
}

function ImageChoice({ image, privacyMode, selected = false, index, disabled, onClick }: {
  image: SuggestionImage; privacyMode: boolean; selected?: boolean; index?: number; disabled: boolean; onClick(): void;
}) {
  const both = image.pixaiScore >= .85 && image.canaryScore >= .85;
  return <button type="button" className={`character-suggestion-image${selected ? " character-suggestion-image--selected" : ""}`} disabled={disabled} aria-pressed={selected} aria-label={`${image.assetId} 크게 보기`} onClick={onClick}>
    {!privacyMode && <AssetImage draggable={false} src={thumbnailUrl(image.assetId)} alt="" loading="lazy" />}
    {index && <b>{index}</b>}{image.solo && <span className="character-suggestion-image__solo">단독</span>}{!image.insideSeries && <span className="character-suggestion-image__outside">밖</span>}
    <span className={`character-suggestion-image__score${both ? "" : " character-suggestion-warning"}`} aria-label={`PixAI ${image.pixaiScore.toFixed(3)} · canary ${image.canaryScore.toFixed(3)}`}>{Math.max(image.pixaiScore, image.canaryScore).toFixed(2)}</span>
  </button>;
}

function ImagePreview({ image, privacyMode, selected, canAdd, onMove, onToggle, onClose }: {
  image: SuggestionImage; privacyMode: boolean; selected: boolean; canAdd: boolean;
  onMove(delta: number): void; onToggle(): void; onClose(): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    surface.current?.focus();
    return () => {
      // A reference toggle can move the opener to the other strip.
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".character-suggestion-image"))
        .find(item => item.getAttribute("aria-label") === opener?.getAttribute("aria-label"));
      (opener?.isConnected ? opener : button)?.focus();
    };
  }, []);
  return <div ref={surface} className="character-suggestion-preview" role="dialog" aria-modal="true" aria-label="참조 이미지 크게 보기" tabIndex={-1}
    onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); event.stopPropagation(); onMove(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Tab") {
        const buttons = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    <div className="character-suggestion-preview__image">
      {privacyMode ? <span>프라이버시 모드</span> : <AssetImage src={assetUrl(image.assetId)} alt="참조 미리보기" />}
    </div>
    <div className="character-suggestion-preview__controls">
      <Button aria-label="이전 이미지" onClick={() => onMove(-1)}>←</Button>
      <span>{image.solo && "단독 · "}PixAI {image.pixaiScore.toFixed(2)} · canary {image.canaryScore.toFixed(2)}</span>
      <Button aria-label="다음 이미지" onClick={() => onMove(1)}>→</Button>
      <Button disabled={!selected && !canAdd} onClick={onToggle}>{selected ? "참조에서 제거" : "참조로"}</Button>
      <Button onClick={onClose}>미리보기 닫기</Button>
    </div>
  </div>;
}
