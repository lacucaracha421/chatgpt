import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { Dialog } from "../../shared/ui/Dialog";
import { Button } from "../../shared/ui/Button";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { avError } from "../avClient";
import type { AvCommonsPreview, AvGateway, AvPortrait, AvPortraitSource, PortraitRect } from "../avTypes";
import { AvPortrait as Portrait } from "./AvPortrait";
import "./avPortraitPicker.css";

type PortraitSourceKind = "crop" | "commons" | "none";

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

function initialRect(source: AvPortraitSource | null): PortraitRect {
  if (!source || source.width <= 0 || source.height <= 0) return { x: .25, y: .15, w: .5, h: .7 };
  const imageRatio = source.width / source.height;
  let w = .5;
  let h = w * imageRatio / .75;
  if (h > .8) { h = .8; w = h * .75 / imageRatio; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function zoomRect(base: PortraitRect, zoom: number): PortraitRect {
  const w = base.w / zoom, h = base.h / zoom;
  return { x: clamp(base.x + (base.w - w) / 2, 0, 1 - w), y: clamp(base.y + (base.h - h) / 2, 0, 1 - h), w, h };
}

function artworkUrl(id: string, revision: string, large = false) {
  const base = large ? workArtworkUrl(id) : workArtworkThumbnailUrl(id);
  return `${base}?v=${encodeURIComponent(revision)}`;
}

export function AvPortraitPicker({ personId, personName, wikidataId = null, api, onClose, onSaved }: {
  personId: string; personName: string; wikidataId?: string | null; api: AvGateway; onClose(): void; onSaved(portrait: AvPortrait | null): void;
}) {
  const { privacyMode } = usePrivacy();
  const [sources, setSources] = useState<AvPortraitSource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<PortraitSourceKind>("crop");
  const [rect, setRect] = useState<PortraitRect>(() => initialRect(null));
  const [baseRect, setBaseRect] = useState<PortraitRect>(() => initialRect(null));
  const [zoom, setZoom] = useState(1);
  const [commons, setCommons] = useState<AvCommonsPreview | null>(null);
  const [commonsLoading, setCommonsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; rect: PortraitRect } | null>(null);
  const cropSurfaceRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => sources.find(source => source.artworkId === selectedId) ?? sources[0] ?? null, [selectedId, sources]);

  useEffect(() => {
    let active = true;
    setError(null);
    void api.listPortraitSources(personId).then(value => {
      if (!active) return;
      const ordered = [...(value ?? [])].sort((a, b) => Number(b.solo) - Number(a.solo));
      setSources(ordered);
      setSelectedId(ordered[0]?.artworkId ?? null);
      const next = initialRect(ordered[0] ?? null);
      setRect(next); setBaseRect(next); setZoom(1);
    }, reason => { if (active) setError(avError(reason)); });
    return () => { active = false; };
  }, [api, personId]);

  useEffect(() => {
    if (sourceKind !== "commons") return;
    let active = true;
    setCommonsLoading(true); setError(null); setCommons(null);
    void api.previewCommonsPortrait(personId).then(value => { if (active) setCommons(value); }, reason => { if (active) setError(avError(reason)); })
      .finally(() => { if (active) setCommonsLoading(false); });
    return () => { active = false; };
  }, [api, personId, sourceKind]);

  function selectCover(source: AvPortraitSource) {
    setSelectedId(source.artworkId);
    const next = initialRect(source);
    setRect(next); setBaseRect(next); setZoom(1);
  }

  function onCropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    drag.current = { x: event.clientX, y: event.clientY, rect };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onCropPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    const bounds = cropSurfaceRef.current?.getBoundingClientRect();
    if (!active || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    setRect(current => ({ ...current, x: clamp(active.rect.x + (event.clientX - active.x) / bounds.width, 0, 1 - current.w), y: clamp(active.rect.y + (event.clientY - active.y) / bounds.height, 0, 1 - current.h) }));
  }
  function endCrop() { drag.current = null; }
  function changeZoom(value: number) {
    setZoom(value);
    // Zoom around the frame's current centre so a dragged frame stays on the face.
    setRect(current => { const next = zoomRect(baseRect, value); return { ...next, x: clamp(current.x + current.w / 2 - next.w / 2, 0, 1 - next.w), y: clamp(current.y + current.h / 2 - next.h / 2, 0, 1 - next.h) }; });
  }
  function resetCrop() { setZoom(1); setRect(baseRect); }

  async function save() {
    setBusy(true); setError(null);
    try {
      if (sourceKind === "none") {
        await api.clearPortrait(personId);
        onSaved(null); onClose(); return;
      }
      const portrait = sourceKind === "commons" ? await api.useCommonsPortrait(personId) : selected ? await api.setPortraitCrop(personId, selected.artworkId, rect) : null;
      if (!portrait) { setError("표지에서 자를 앞표지를 먼저 선택해 주세요."); return; }
      onSaved(portrait); onClose();
    } catch (reason) { setError(avError(reason)); }
    finally { setBusy(false); }
  }

  const previewPortrait: AvPortrait | null = sourceKind === "crop" && selected ? { kind: "crop", artworkId: selected.artworkId, revision: selected.revision, rect } : sourceKind === "commons" && commons ? { kind: "commons", ...commons } : null;
  return <Dialog open title={`${personName} 대표 이미지`} variant="wide" onClose={() => { if (!busy) onClose(); }}>
    <div className="av-portrait-picker">
      <nav className="av-portrait-picker__sources" aria-label="대표 이미지 출처">
        <p className="av-portrait-picker__section-label">출처</p>
        <SourceButton active={sourceKind === "crop"} onClick={() => setSourceKind("crop")} title="표지에서 자르기" detail={`앞표지 ${sources.length}장`} />
        <SourceButton active={sourceKind === "commons"} onClick={() => setSourceKind("commons")} title="위키미디어 공용" detail="Wikidata 대표 사진" />
        <SourceButton active={sourceKind === "none"} onClick={() => setSourceKind("none")} title="사진 없이" detail="이니셜 모노그램" />
        <p className="av-portrait-picker__note">대표 이미지는 사용자가 고른 표지 자르기, 공용 사진, 이니셜 순서로 표시합니다.</p>
      </nav>
      <div className="av-portrait-picker__work">
        {sourceKind === "crop" && <>
          <div className="av-portrait-picker__cover-list" aria-label="대표 이미지 표지 목록">
            {sources.map(source => <button key={source.artworkId} type="button" className={source.artworkId === selected?.artworkId ? "is-selected" : ""} onClick={() => selectCover(source)} aria-label={`${source.productCode ?? source.name} 표지${source.solo ? " 단독 작품" : ""}`}>
              {!privacyMode ? <img src={artworkUrl(source.artworkId, source.revision)} alt="" loading="lazy" /> : <span>비공개</span>}
              <small>{source.productCode ?? source.name}</small>
            </button>)}
          </div>
          {selected ? <div className="av-portrait-picker__crop-surface">
            <div className="av-portrait-picker__crop-image" ref={cropSurfaceRef} style={{ aspectRatio: `${selected.width} / ${selected.height}` }}>
              {!privacyMode ? <img src={artworkUrl(selected.artworkId, selected.revision, true)} alt="선택한 앞표지" /> : <span>비공개 모드</span>}
              <div className="av-portrait-picker__crop-frame" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} onPointerDown={onCropPointerDown} onPointerMove={onCropPointerMove} onPointerUp={endCrop} onPointerCancel={endCrop} role="slider" aria-label="초상화 자르기 영역" aria-valuetext="3 대 4 자르기 영역"><i /><i /><i /><i /></div>
            </div>
          </div> : <p className="av-portrait-picker__empty">자를 수 있는 앞표지가 없습니다.</p>}
          <div className="av-portrait-picker__crop-controls"><label htmlFor="av-portrait-zoom">확대</label><input id="av-portrait-zoom" type="range" min="1" max="3" step=".1" value={zoom} onChange={event => changeZoom(Number(event.target.value))} /><Button size="sm" onClick={resetCrop}>처음 위치</Button><span>틀을 끌어 얼굴에 맞추세요 · 3:4 고정</span></div>
        </>}
        {sourceKind === "commons" && <div className="av-portrait-picker__commons">
          {commonsLoading && <p role="status">위키미디어 공용 사진을 불러오는 중…</p>}
          {!commonsLoading && !commons && <p role="status">위키미디어 공용 사진이 없습니다</p>}
          {commons && <>
            {!privacyMode && <img src={commons.dataUrl} alt={`${personName} 공용 사진 미리보기`} />}
            <dl><div><dt>파일</dt><dd>{commons.fileName}</dd></div><div><dt>저작자</dt><dd>{commons.author ?? "알 수 없음"}</dd></div><div><dt>라이선스</dt><dd>{commons.license ?? "표시 정보 없음"}</dd></div><div><dt>Wikidata</dt><dd>{wikidataId ?? "없음"}</dd></div></dl>
            <p>배우 페이지에 저작자와 라이선스를 작게 표시합니다.</p>
          </>}
        </div>}
        {sourceKind === "none" && <div className="av-portrait-picker__none"><Portrait portrait={null} name={personName} size="performer" /><p>사진 없이 이름 첫 글자를 사용합니다.</p></div>}
      </div>
      <aside className="av-portrait-picker__previews" aria-label="대표 이미지 미리보기">
        <p className="av-portrait-picker__section-label">미리보기</p>
        <span>상세 · 출연</span><div className="av-portrait-picker__avatar-row"><PreviewPortrait portrait={previewPortrait} name={personName} size={84} /><PreviewPortrait portrait={previewPortrait} name={personName} size={40} /><PreviewPortrait portrait={previewPortrait} name={personName} size={24} /></div>
        <span>배우 페이지</span><div className="av-portrait-picker__performer-preview"><PreviewPortrait portrait={previewPortrait} name={personName} size="performer" /></div>
        <span>홈 · 오늘의 AV 배우</span><div className="av-portrait-picker__home-preview"><PreviewPortrait portrait={previewPortrait} name={personName} size="home" /><b>{personName}</b></div>
      </aside>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="ui-dialog__actions"><Button disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy || (sourceKind === "commons" && (!commons || commonsLoading))} onClick={() => void save()}>대표 이미지로 쓰기</Button></div>
  </Dialog>;
}

function SourceButton({ active, onClick, title, detail }: { active: boolean; onClick(): void; title: string; detail: string }) {
  return <button type="button" className={`av-portrait-picker__source${active ? " is-selected" : ""}`} aria-pressed={active} onClick={onClick}><b>{title}</b><span>{detail}</span></button>;
}

function PreviewPortrait({ portrait, name, size }: { portrait: AvPortrait | null; name: string; size: number | "performer" | "home" }) {
  return <Portrait portrait={portrait} name={name} size={size} />;
}
