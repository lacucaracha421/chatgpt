import {useEffect, useMemo, useState} from 'react';
import type {PortraitRect} from '../src/collections/avTypes';
import {initialPortraitRect, portraitCropStyle, zoomPortraitRect} from '../src/collections/av/portraitCrop';
import {PortraitCropSurface} from '../src/collections/av/PortraitCropSurface';
import {Button, EmptyState, Skeleton} from './ui';
import {StepSlider} from './StepSlider';
import {useArtworkSet} from './collectionArtwork';
import {performersOf} from './AvCollections';
import type {CollectionSummary} from './collectionModel';

/** A cover the performer can be cut from: the selected front cover of one of their AV works. */
export type PortraitCropSource = {work: CollectionSummary; artworkId: string; solo: boolean};
/** The covers 표지에서 자르기 offers, as the PC lists them: solo works first, then the newest release first. */
export function portraitCropSources(personId: string, works: CollectionSummary[]): PortraitCropSource[] {
  const date = (work: CollectionSummary) => work.av?.releaseDate ?? work.releaseDate ?? '';
  return works.flatMap<PortraitCropSource>(work => {
    const people = performersOf(work);
    return work.selectedWorkArtworkId && people.some(person => person.id === personId) ? [{work, artworkId: work.selectedWorkArtworkId, solo: people.length === 1}] : [];
  }).sort((a, b) => Number(b.solo) - Number(a.solo) || Number(!date(a.work)) - Number(!date(b.work)) || date(b.work).localeCompare(date(a.work)) || a.work.id.localeCompare(b.work.id));
}

/** The decoded size of an image already loaded by the artwork hook. */
function useImageSize(url: string | undefined) {
  const [size, setSize] = useState<{url: string; width: number; height: number} | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const image = new Image();
    image.onload = () => { if (live && image.naturalWidth > 0 && image.naturalHeight > 0) setSize({url, width: image.naturalWidth, height: image.naturalHeight}); };
    image.src = url;
    return () => { live = false; };
  }, [url]);
  return size?.url === url ? size : null;
}

function CoverChoice({source, revision, selected, onChoose}: {source: PortraitCropSource; revision: string; selected: boolean; onChoose(): void}) {
  const url = useArtworkSet(source.work, {front: {id: source.artworkId, original: false}}, revision, true).urls.front;
  const code = source.work.av?.productCode ?? source.work.name;
  return <button type="button" aria-pressed={selected} aria-label={`${code} 표지${source.solo ? ' 단독 작품' : ''}`} onClick={onChoose}>
    {url ? <img src={url} alt="" draggable={false}/> : <Skeleton label={null}/>}<small>{code}</small>
  </button>;
}

type Frame = {artworkId: string; url: string; width: number; height: number; base: PortraitRect};

/**
 * 표지에서 자르기 on the tablet (PC `AvPortraitPicker`): pick one of the performer's covers, drag the 3:4 frame onto
 * the face and zoom it; the previews read the crop as every portrait does. The shown cover stays until the next one
 * has decoded, so choosing another cover never blanks the frame.
 */
export function AvPortraitCrop({personId, name, works, revision, disabled, onSave}: {
  personId: string; name: string; works: CollectionSummary[]; revision: string; disabled: boolean;
  onSave(artworkId: string, rect: PortraitRect, url: string): void;
}) {
  const sources = useMemo(() => portraitCropSources(personId, works), [personId, works]);
  const [chosen, setChosen] = useState<string | null>(null);
  const source = sources.find(item => item.artworkId === chosen) ?? sources[0] ?? null;
  const art = useArtworkSet(source?.work ?? null, source ? {front: {id: source.artworkId, original: true}} : {}, revision, !!source);
  const size = useImageSize(art.ready ? art.urls.front : undefined);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [rect, setRect] = useState<PortraitRect>(() => initialPortraitRect());
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (!source || !size || frame?.artworkId === source.artworkId && frame.url === size.url) return;
    const base = initialPortraitRect(size.width, size.height);
    setFrame({artworkId: source.artworkId, url: size.url, width: size.width, height: size.height, base}); setRect(base); setZoom(1);
  }, [source?.artworkId, size]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sources.length) return <EmptyState inline title="자를 수 있는 앞표지가 없습니다"/>;
  const loading = !frame || frame.artworkId !== source?.artworkId;
  const step = Math.round((zoom - 1) * 10);
  const preview = frame && portraitCropStyle(frame.url, rect);
  return <div className="tablet-portrait-crop">
    <div className="tablet-portrait-crop__covers" aria-label="대표 이미지 표지 목록">
      {sources.map(item => <CoverChoice key={item.artworkId} source={item} revision={revision} selected={item.artworkId === source?.artworkId} onChoose={() => setChosen(item.artworkId)}/>)}
    </div>
    <div className="tablet-portrait-crop__stage" aria-busy={loading}>
      {frame ? <PortraitCropSurface rect={rect} onRect={setRect} aspectRatio={`${frame.width} / ${frame.height}`}><img src={frame.url} alt="선택한 앞표지" draggable={false}/></PortraitCropSurface>
        : <Skeleton className="tablet-portrait-crop__placeholder" label="앞표지를 불러오는 중"/>}
    </div>
    <div className="tablet-portrait-crop__controls">
      <StepSlider label="확대" count={21} index={step} defaultIndex={0} valueText={index => `${(1 + index / 10).toFixed(1)}배`} onChange={index => {
        const value = 1 + index / 10;
        setZoom(value);
        if (frame) setRect(current => zoomPortraitRect(frame.base, value, current));
      }}/>
      <Button variant="ghost" disabled={!frame} onClick={() => { if (frame) { setZoom(1); setRect(frame.base); } }}>처음 위치</Button>
    </div>
    <div className="tablet-portrait-crop__previews" aria-label="대표 이미지 미리보기">
      <span className="av-portrait tablet-portrait-crop__preview has-image" aria-label={`${name} 배우 페이지 미리보기`}>{preview && <span className="av-portrait__crop" style={preview}/>}</span>
      <span className="av-portrait av-portrait-small has-image" aria-label={`${name} 출연 미리보기`}>{preview && <span className="av-portrait__crop" style={preview}/>}</span>
    </div>
    <Button variant="primary" disabled={disabled || loading} onClick={() => { if (frame && !loading) onSave(frame.artworkId, rect, frame.url); }}>대표 이미지로 쓰기</Button>
  </div>;
}
