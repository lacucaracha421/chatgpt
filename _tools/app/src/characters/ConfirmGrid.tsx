import { memo, useState, type MouseEvent, type Ref } from "react";
import { MagnifyingGlassPlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { AssetImage } from "../privacy/AssetImage";
import { thumbnailUrl } from "../assets/mediaUrl";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { needsSingleLook, reasonBadges, tileNote, type ConfirmCharacterGroup, type ConfirmItem } from "./confirmModel";

type Props = {
  groups: readonly ConfirmCharacterGroup[];
  /** Header per character; off when the shown set holds a single character. */
  grouped: boolean;
  marked: ReadonlySet<string>;
  privacyMode: boolean;
  /** Plays the soft first entrance; a grid that comes back from the one-at-a-time view does not repeat it. */
  intro: boolean;
  scrollRef: Ref<HTMLDivElement>;
  onToggle: (item: ConfirmItem, event: MouseEvent) => void;
  onZoom: (item: ConfirmItem) => void;
};

/** 확인 as a grid: every candidate of the shown set at once; a click marks one 아님, a double click or the magnifier opens it alone. */
export function ConfirmGrid({ groups, grouped, marked, privacyMode, intro, scrollRef, onToggle, onZoom }: Props) {
  const [playIntro] = useState(intro);
  const privateClass = privacyMode ? "character-private" : undefined;
  return <div className={`confirm-grid${playIntro ? " confirm-grid--intro" : ""}`} ref={scrollRef}>
    {groups.map(group => <section key={group.targetId} className="confirm-grid__group" aria-label={grouped ? group.targetName : undefined}>
      {grouped && <header className="confirm-grid__group-head">
        <h3>{group.targetName}</h3>
        <span className="confirm-grid__group-count numeric">{group.items.length.toLocaleString()}장</span>
        {group.referenceAssetIds.length > 0 && <ul className="confirm-grid__refs" aria-label={`${group.targetName} 레퍼런스`}>
          {group.referenceAssetIds.map(id => <li key={id}><AssetImage src={thumbnailUrl(id)} alt="" className={privateClass} loading="lazy" draggable={false} /></li>)}
        </ul>}
      </header>}
      <ul className="confirm-grid__tiles">
        {group.items.map(item => <Tile key={item.key} item={item} isMarked={marked.has(item.key)} privateClass={privateClass} onToggle={onToggle} onZoom={onZoom} />)}
      </ul>
    </section>)}
  </div>;
}

type TileProps = {
  item: ConfirmItem;
  isMarked: boolean;
  privateClass: string | undefined;
  onToggle: (item: ConfirmItem, event: MouseEvent) => void;
  onZoom: (item: ConfirmItem) => void;
};

const Tile = memo(function Tile({ item, isMarked, privateClass, onToggle, onZoom }: TileProps) {
  const single = needsSingleLook(item);
  const note = tileNote(item);
  const label = `${item.targetName} · ${item.originalName}`;
  return <li className="confirm-grid__tile" data-marked={isMarked ? "true" : undefined} data-single={single ? "true" : undefined}>
    {single
      ? <button type="button" className="confirm-grid__pick" aria-label={`${label} · 한 장씩 보기 필요`} onClick={() => onZoom(item)}>
        <Picture item={item} privateClass={privateClass} />
      </button>
      : <button type="button" className="confirm-grid__pick" aria-label={label} aria-pressed={isMarked} onClick={event => onToggle(item, event)} onDoubleClick={() => onZoom(item)}>
        <Picture item={item} privateClass={privateClass} />
        {isMarked && <Badge className="confirm-grid__mark" variant="danger" icon={XMarkIcon}>아님</Badge>}
      </button>}
    <Button className="confirm-grid__zoom" size="icon" variant="quiet" aria-label={`${label} 크게 보기`} onClick={() => onZoom(item)}><MagnifyingGlassPlusIcon aria-hidden="true" /></Button>
    <div className="confirm-grid__caption">
      <div className="confirm-grid__badges">
        {reasonBadges(item).map(text => <Badge key={text}>{text}</Badge>)}
        {single && <Badge>한 장씩 보기 필요</Badge>}
      </div>
      {note && <p className="confirm-grid__note">{note}</p>}
    </div>
  </li>;
});

function Picture({ item, privateClass }: { item: ConfirmItem; privateClass: string | undefined }) {
  return <span className="confirm-grid__picture">
    <AssetImage className={privateClass} src={thumbnailUrl(item.assetId)} alt="" loading="lazy" draggable={false} />
  </span>;
}
