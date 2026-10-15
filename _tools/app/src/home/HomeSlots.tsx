import { EmptyState } from "../shared/ui/EmptyState";
import { SectionLabel } from "../shared/ui/SectionLabel";
import "./homeTools.css";
import { useState } from "react";
import { Dialog } from "../shared/ui/Dialog";
import { BoosterPack } from "../cards/BoosterPack";
import { PackOpening } from "../cards/PackOpening";
import { demoDeck } from "../cards/demoDeck";

/** 링크 보관: the tile is reserved in the tools row; storing links comes later. */
export function HomeLinkVault() {
  return <section className="home-attention-section home-tool home-slot" aria-label="링크 보관">
    <SectionLabel title="링크 보관" />
    <div className="home-tool__body"><div className="home-slot__empty"><EmptyState inline title="곧 추가됩니다" /></div></div>
  </section>;
}

/** 오늘의 카드: a place of fixed height, so the list below it does not move when the card feature arrives. */
export function HomeDailyCard() {
  const [open, setOpen] = useState(false);
  const demo = demoDeck();
  return <section className="home-attention-section home-daily-card" aria-label="오늘의 카드">
    <SectionLabel title="오늘의 카드" />
    <div className="home-daily-card__body card-demo-preview">
      <button type="button" className="card-demo-preview__button" aria-label="오늘의 카드 미리보기 열기" onClick={() => setOpen(true)}>
        <span className="card-demo-preview__pack" aria-hidden="true" inert><BoosterPack cover={demo.cover} cardCount={demo.cards.length} disabled /></span>
        <span className="card-demo-preview__label">미리보기</span>
      </button>
    </div>
    <Dialog open={open} title="오늘의 카드 미리보기" variant="fullscreen" onClose={() => setOpen(false)}>
      {open && <PackOpening cards={demo.cards} cover={demo.cover} onClose={() => setOpen(false)} />}
    </Dialog>
  </section>;
}
