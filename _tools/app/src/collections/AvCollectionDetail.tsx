import { useEffect, useState } from "react";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { workArtworkUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { CollectionSidebarSection } from "./CollectionSidebarSection";
import { GameCase } from "./GameCase";
import { avError, avGateway } from "./avClient";
import type { AvCoverSet, AvDetails, AvGateway } from "./avTypes";
import { AvEditPanel } from "./AvEditPanel";
import { AvArtworkDialog } from "./AvArtworkDialog";
import { CompleteCoverViewer } from "./physical/CompleteCoverViewer";
import "./avCollections.css";

export function AvCollectionDetail({ collection, scope, api = avGateway, onChanged, onEdit, onToggleShowcase, onDelete }: {
  collection: CollectionSummary; scope: string; api?: AvGateway; onChanged(): Promise<void>;
  onEdit(): void; onToggleShowcase(): void; onDelete(): void;
}) {
  const { privacyMode } = usePrivacy();
  const [details, setDetails] = useState<AvDetails | null>(null), [covers, setCovers] = useState<AvCoverSet | null>(null);
  const [panel, setPanel] = useState<"info" | "artwork" | "viewer" | null>(null), [error, setError] = useState<string | null>(null), [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true; setError(null); setDetails(null); setCovers(null);
    void Promise.all([api.getDetails(collection.id), api.getCoverSet(collection.id)]).then(([info, images]) => { if (active) { setDetails(info); setCovers(images); } }, reason => { if (active) setError(avError(reason)); });
    return () => { active = false; };
  }, [api, collection.id, collection.updatedAt, scope, reload]);
  function changed() { void onChanged().catch(reason => setError(avError(reason))); }
  return <article className="av-collection-detail" aria-label="AV 상세">
    <CollectionSidebarSection actions><Menu label="작품 관리" trigger="관리" items={[
      { id: "edit", label: "컬렉션 편집", onSelect: onEdit },
      { id: "av-info", label: "AV 정보 편집", disabled: !details, onSelect: () => setPanel("info") },
      { id: "av-artwork", label: "표지 앞면·책등·뒷면", disabled: !covers, onSelect: () => setPanel("artwork") },
      { id: "showcase", label: collection.showcase ? "쇼케이스에서 제외" : "쇼케이스에 추가", onSelect: onToggleShowcase },
      { id: "delete", label: "컬렉션 삭제", destructive: true, onSelect: onDelete },
    ]} /></CollectionSidebarSection>
    {error && <p role="alert">{error} <Button onClick={() => setReload(value => value + 1)}>다시 불러오기</Button></p>}
    {!details && !error && <p role="status">불러오는 중…</p>}
    <div className="av-collection-detail__identity">
      <button className="av-collection-detail__cover" type="button" aria-label="표지 감상" disabled={!covers?.frontId || privacyMode} onClick={() => setPanel("viewer")}>
        {covers?.frontId && !privacyMode ? <GameCase src={workArtworkUrl(covers.frontId)} alt={`${collection.name} 앞표지`} scope={scope} revision={covers.revision} large /> : <span>{privacyMode ? "비공개 모드" : "표지 없음"}</span>}
      </button>
      <div><h2>{collection.name}</h2>{collection.originalTitle && <p>{collection.originalTitle}</p>}
        <p>{[details?.productCode, collection.releaseDate, collection.productionCompany, details?.label, details?.series].filter(Boolean).join(" · ")}</p>
        {details && <Button onClick={() => setPanel("info")}>AV 정보 편집</Button>}
        {covers && <Button onClick={() => setPanel("artwork")}>표지 등록</Button>}
      </div>
    </div>
    {details && (["performer", "director"] as const).map(role => {
      const people = details.people.filter(person => person.role === role);
      return people.length > 0 && <section key={role}><h3>{role === "performer" ? "출연" : "감독"}</h3><p>{people.map(person => person.creditName || person.displayName).join(" · ")}</p></section>;
    })}
    {collection.description && <p>{collection.description}</p>}
    <details className="av-collection-detail__visibility"><summary>보관 범위</summary><p>AV 작품은 PC에서 표시하며 모바일 컬렉션 공개 목록에 포함하지 않습니다. PC 복구점에는 다른 컬렉션과 함께 기록됩니다. 별도 암호화 금고는 아닙니다.</p><p>표지 원본은 라이브러리의 작품 아트워크로 보관됩니다. 이미지 복구에는 원본 폴더 백업도 필요합니다.</p></details>
    {panel === "info" && details && <AvEditPanel details={details} api={api} onClose={() => setPanel(null)} onSaved={value => { setDetails(value); changed(); }} />}
    {panel === "artwork" && covers && <AvArtworkDialog collectionId={collection.id} covers={covers} api={api} onClose={() => setPanel(null)} onSaved={value => { setCovers(value); changed(); }} />}
    {panel === "viewer" && covers && <CompleteCoverViewer title={collection.name} covers={covers} scope={scope} onClose={() => setPanel(null)} />}
  </article>;
}
