import { EmptyState } from "../shared/ui/EmptyState";
import { SectionLabel } from "../shared/ui/SectionLabel";
import "./homeTools.css";
export { HomeDailyCard } from "../cards/HomeDailyCard";

/** 링크 보관: the tile is reserved in the tools row; storing links comes later. */
export function HomeLinkVault() {
  return <section className="home-attention-section home-tool home-slot" aria-label="링크 보관">
    <SectionLabel title="링크 보관" />
    <div className="home-tool__body"><div className="home-slot__empty"><EmptyState inline title="곧 추가됩니다" /></div></div>
  </section>;
}

