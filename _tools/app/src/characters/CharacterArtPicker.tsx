import { useState } from "react";
import { useSeriesImages } from "./useSeriesImages";
import { AssetGallery } from "../assets/AssetGallery";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";

export function CharacterArtPicker({ seriesId, privacyMode, title, onChoose, onClose }: { seriesId: string; privacyMode: boolean; title: string; onChoose: (id: string) => void; onClose: () => void }) {
  const images = useSeriesImages(seriesId);
  const { items, cursor, busy, error, load } = images;
  const [chosen, setChosen] = useState<string | null>(null);
  return <Dialog open title={title} variant="wide" onClose={onClose}><div className="character-picker">
    {error && <p role="alert">{error}</p>}
    <div className="character-picker__gallery"><AssetGallery layout="masonry" items={items.filter(a => a.media.kind === "image")} privacyMode={privacyMode} targetRowHeight={160} selectedAssetIds={new Set(chosen ? [chosen] : [])} onSelectionGesture={a => setChosen(a.id)} onOpen={a => onChoose(a.id)} /></div>
    <div className="character-actions"><Button disabled={busy} onClick={() => void images.importImages().then(ids => { if (ids[0]) setChosen(ids[0]); })}>파일에서 가져오기</Button><Button disabled={busy || !cursor} onClick={() => void load(cursor)}>더 불러오기</Button><Button disabled={!chosen} onClick={() => chosen && onChoose(chosen)}>선택</Button><Button onClick={onClose}>닫기</Button></div>
  </div></Dialog>;
}
