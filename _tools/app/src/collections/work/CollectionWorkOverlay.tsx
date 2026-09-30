import { useEffect, useMemo, useRef, useState } from "react";
import { useLibrary } from "../../library/LibraryContext";
import type { CollectionSummary, UpdateCollection } from "../../library/types";
import { assetUrl, collectionSourcePreviewUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { useBackHandler, useBackNavigationContext } from "../../shared/navigation/BackNavigation";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Skeleton } from "../../shared/ui/Skeleton";
import { avError, avGateway } from "../avClient";
import type { AvGateway } from "../avTypes";
import { AvEditPanel } from "../AvEditPanel";
import { AvArtworkDialog } from "../AvArtworkDialog";
import { AvPerformerPage } from "../av/AvPerformerPage";
import { CollectionEditDialog } from "../CollectionEditDialog";
import { IgdbImportDialog } from "../IgdbImportDialog";
import "../avCollections.css";
import { casePlatform } from "../case/CollectionCase";
import { CollectionWorkScreen, type CollectionWorkData, type WorkActions } from "./CollectionWorkScreen";

export type CollectionWorkOverlayProps = {
  collection: CollectionSummary; collections: CollectionSummary[]; listOrder?: string[];
  onExit(): void; onChanged(): Promise<void>; onOpenSettings(): void; onOpenCollection?(id: string): void; api?: AvGateway;
};
export function CollectionWorkOverlay({ collection, collections, listOrder, onExit, onChanged, onOpenSettings, onOpenCollection, api = avGateway }: CollectionWorkOverlayProps) {
  const { gateway } = useLibrary();
  const { privacyMode } = usePrivacy();
  const [provider, setProvider] = useState<{ id: string; connected: boolean }>({ id: collection.id, connected: false });
  const [loaded, setLoaded] = useState<CollectionWorkData | null>(() => collection.type === "game" ? {
    collection, av: null, covers: null, related: null, artworks: [], providerConnected: false,
    position: (listOrder?.includes(collection.id) ? listOrder : collections.filter(item => item.type === collection.type).map(item => item.id)).indexOf(collection.id) + 1,
    total: (listOrder?.includes(collection.id) ? listOrder : collections.filter(item => item.type === collection.type).map(item => item.id)).length,
    case: { title: collection.name, publisher: collection.publisher, platform: casePlatform(collection.platforms), privacy: privacyMode, spine: null, back: null,
      front: collection.selectedWorkArtworkId ? workArtworkUrl(collection.selectedWorkArtworkId) : collection.coverAssetId ? assetUrl(collection.coverAssetId) : collection.sourcePath ? collectionSourcePreviewUrl(collection.id) : null },
  } : null);
  const [panel, setPanel] = useState<{ kind: "edit" | "igdb" | "av" | "artwork" | "delete"; data: CollectionWorkData } | null>(null);
  const [performer, setPerformer] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const order = (listOrder?.includes(collection.id) ? listOrder : collections.filter(item => item.type === collection.type).map(item => item.id)).filter(id => collections.some(item => item.id === id));
  const orderKey = order.join("|");
  useEffect(() => {
    let active = true;
    setError(null);
    void (async () => {
      try {
        const [av, covers, related, artworks] = await Promise.all([
          collection.type === "av" ? api.getDetails(collection.id) : Promise.resolve(null),
          collection.type === "av" ? api.getCoverSet(collection.id) : Promise.resolve(null),
          collection.type === "av" && typeof api.getRelated === "function" ? api.getRelated(collection.id) : Promise.resolve(null),
          gateway.listCollectionWorkArtworks(collection.id).catch(() => []),
        ]);
        if (!active) return;
        const artworkUrl = (id: string | null) => id ? `${workArtworkUrl(id)}?v=${encodeURIComponent(covers?.revision ?? collection.updatedAt)}` : null;
        const front = covers ? artworkUrl(covers.frontId) : collection.selectedWorkArtworkId ? workArtworkUrl(collection.selectedWorkArtworkId) : collection.coverAssetId ? assetUrl(collection.coverAssetId) : collection.sourcePath ? collectionSourcePreviewUrl(collection.id) : null;
        setLoaded({ collection, av, covers, related, artworks: artworks.filter(item => !["cover", "spine", "back", "volume_cover"].includes(item.kind)), providerConnected: false, position: order.indexOf(collection.id) + 1, total: order.length,
          case: { title: av?.titleJa?.trim() || collection.name, platform: collection.type === "av" ? "av" : casePlatform(collection.platforms), publisher: collection.publisher, privacy: privacyMode, front, spine: covers ? artworkUrl(covers.spineId) : null, back: covers ? artworkUrl(covers.backId) : null },
        });
      } catch (reason) { if (active) setError(avError(reason)); }
    })();
    return () => { active = false; };
  }, [api, gateway, collection, reload, privacyMode, orderKey]);
  useEffect(() => {
    if (collection.type !== "game") return;
    let active = true;
    void gateway.getIgdbConnection(collection.id).then(value => { if (active) setProvider({ id: collection.id, connected: Boolean(value) }); }, reason => { if (active) { setProvider({ id: collection.id, connected: false }); setError(avError(reason)); } });
    return () => { active = false; };
  }, [gateway, collection.id, collection.type, reload]);
  useEffect(() => {
    if (collection.type !== "game") return;
    let active = true;
    void gateway.importCollectionArtworks(collection.id).then(count => { if (active && count > 0) { setReload(value => value + 1); void changedRef.current().catch(reason => setError(avError(reason))); } }, () => undefined);
    return () => { active = false; };
  }, [gateway, collection.id, collection.type]);
  const screenData = useMemo(() => loaded ? { ...loaded, providerConnected: provider.id === loaded.collection.id && provider.connected, case: { ...loaded.case, privacy: privacyMode } } : null, [loaded, provider, privacyMode]);
  const canClose = !panel && !performer;
  const navigation = useBackNavigationContext();
  useBackHandler(onExit, 10, canClose);
  useBackHandler(() => setPerformer(null), 20, Boolean(performer) && !panel);
  useEffect(() => {
    if (navigation || panel) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); if (performer) setPerformer(null); else onExit(); } };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [navigation, panel, performer, onExit]);
  async function mutate(operation: () => Promise<unknown>) {
    try { await operation(); await onChanged(); setReload(value => value + 1); }
    catch (reason) { setError(avError(reason)); }
  }
  const actions: WorkActions = {
    onClose: onExit,
    onStep: offset => { const index = order.indexOf(loaded?.collection.id ?? collection.id); const id = order[index + offset]; if (id) onOpenCollection?.(id); },
    onEdit: item => { if (loaded) setPanel({ kind: "edit", data: { ...loaded, collection: item } }); },
    onShowcase: item => void mutate(() => gateway.setCollectionShowcase(item.id, !item.showcase)),
    onSave: async (item, score, memo) => {
      await gateway.updateCollection(item.id, { ...item, myScore: score, description: memo, personalBase: { myScore: item.myScore, description: item.description } } satisfies UpdateCollection);
      await onChanged(); setReload(value => value + 1);
    },
    onOpenPerson: setPerformer, onOpenCollection,
    onCopyCode: code => { if (code && navigator.clipboard?.writeText) void navigator.clipboard.writeText(code).catch(reason => setError(avError(reason))); },
    onManage: data => [
      { id: "edit", label: "컬렉션 편집", onSelect: () => setPanel({ kind: "edit", data }) },
      { id: "showcase", label: data.collection.showcase ? "쇼케이스에서 제거" : "쇼케이스에 추가", onSelect: () => actions.onShowcase(data.collection) },
      ...(data.collection.type === "game" ? [
        { id: "provider", label: data.providerConnected ? "IGDB 연결됨" : "IGDB 미연결", disabled: true, onSelect: () => undefined },
        { id: "refresh", label: "IGDB 새로고침", disabled: !data.providerConnected, onSelect: () => void mutate(() => gateway.refreshIgdbGame(data.collection.id)) },
        { id: "artwork", label: "표지·hero 변경", disabled: !data.providerConnected, onSelect: () => setPanel({ kind: "igdb", data }) },
      ] : [
        { id: "av", label: "AV 정보 편집", disabled: !data.av, onSelect: () => setPanel({ kind: "av", data }) },
        { id: "artwork", label: "표지 앞면·책등·뒷면", onSelect: () => setPanel({ kind: "artwork", data }) },
      ]),
      { id: "delete", label: "컬렉션 삭제", destructive: true, onSelect: () => setPanel({ kind: "delete", data }) },
    ],
  };
  // Editors retain their exact target even if a route request changes behind them.
  return <>
    {screenData ? <CollectionWorkScreen data={screenData} pending={screenData.collection.id !== collection.id} actions={actions} /> : <div className="work-loading"><Skeleton label="작품 화면" /><Button onClick={onExit}>닫기</Button></div>}
    {error && <div className="work-error" role="alert">{error} <Button size="sm" onClick={() => setReload(value => value + 1)}>다시 시도</Button></div>}
    {panel?.kind === "edit" && <CollectionEditDialog open mode={{ kind: "edit", collection: panel.data.collection }} onClose={() => setPanel(null)} onSubmit={async input => { await gateway.updateCollection(panel.data.collection.id, input as UpdateCollection); await onChanged(); setReload(value => value + 1); }} />}
    {panel?.kind === "igdb" && <IgdbImportDialog open target={{ kind: "existing", collectionId: panel.data.collection.id }} onClose={() => setPanel(null)} onOpenSettings={() => { setPanel(null); onOpenSettings(); }} onApplied={async () => { setPanel(null); await mutate(async () => undefined); }} />}
    {panel?.kind === "av" && panel.data.av && <AvEditPanel details={panel.data.av} api={api} onClose={() => setPanel(null)} onSaved={() => { void mutate(async () => undefined); }} />}
    {panel?.kind === "artwork" && panel.data.covers && <AvArtworkDialog collectionId={panel.data.collection.id} covers={panel.data.covers} api={api} onClose={() => setPanel(null)} onSaved={() => { void mutate(async () => undefined); }} />}
    {panel?.kind === "delete" && <Dialog open title="컬렉션 삭제" onClose={() => setPanel(null)}><p>{panel.data.collection.name} 컬렉션을 삭제하시겠습니까? 원본 에셋은 삭제하지 않습니다.</p><div className="ui-dialog__actions"><Button onClick={() => setPanel(null)}>취소</Button><Button variant="danger" onClick={() => void (async () => { try { await gateway.deleteCollection(panel.data.collection.id); await onChanged(); setPanel(null); onExit(); } catch (reason) { setError(avError(reason)); } })()}>삭제</Button></div></Dialog>}
    {performer && loaded && <div className="work-person-page"><AvPerformerPage key={performer} personId={performer} currentCollectionId={loaded.collection.id} api={api} onBack={() => setPerformer(null)} onOpenCollection={id => { setPerformer(null); onOpenCollection?.(id); }} onOpenPerformer={setPerformer} onOpenSettings={onOpenSettings} /></div>}
  </>;
}
