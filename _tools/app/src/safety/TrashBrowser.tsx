import { BusyLabel } from "../shared/ui/BusyLabel";
import { useAssetMask, usePrivacy } from "../privacy/PrivacyContext";
import { AssetImage } from "../privacy/AssetImage";
import { displayDate } from "../shared/displayDate";
import { ChevronDownIcon, DocumentTextIcon, PhotoIcon, RectangleStackIcon, TrashIcon } from "@heroicons/react/24/outline";
import { trashThumbnailUrl } from "../assets/mediaUrl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ASSET_PAGE_SIZE } from "../library/constants";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionTrashItem, CollectionTrashPage, LibraryGateway, TrashPage, TrashPolicy } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Checkbox } from "../shared/ui/Checkbox";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Field, TextInput } from "../shared/ui/TextInput";
import { Toast } from "../shared/ui/Toast";
import { formatBytes } from "../assets/assetMetadata";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "../app/useAssetAuthoritySync";
import { Tabs } from "../shared/ui/Tabs";
import { Badge } from "../shared/ui/Badge";
import { KIND_LABEL } from "../collections/collectionFormat";
import { notesStore, type NotesStore } from "../notes/store";
import { deletedTrashNotes, rememberedTrashSection, rememberTrashSection, trashNotesNewestFirst, trashTabs, trashExpiry, TRASH_EMPTY, type TrashSection } from "./trashSections";
import { setCollectionTrashCount } from "./trashCounts";
import { StableImage } from "../shared/ui/StableImage";

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const noSubscription = () => () => {};
const noNotes = () => null;

export function TrashBrowser({ onCountChange }: { onCountChange?: (count: number) => void } = {}) {
  const { gateway, library } = useLibrary();
  const { privacyMode } = usePrivacy();
  const [section, setSection] = useState<TrashSection>(rememberedTrashSection);
  const [shownSection, setShownSection] = useState<TrashSection>(section);
  const store = library ? notesStore(library.root) : null;
  const notesState = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? noNotes);
  const deletedNotes = deletedTrashNotes(notesState?.notes ?? []);
  const [collectionPage, setCollectionPage] = useState<CollectionTrashPage | null>(null);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [collectionLoading, setCollectionLoading] = useState(true);
  const collectionGeneration = useRef(0);
  const restoringWorks = useRef(new Set<string>());
  const [page, setPage] = useState<TrashPage | null>(null);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(() => new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [policy, setPolicy] = useState<TrashPolicy | null>(null);
  const [retentionDays, setRetentionDays] = useState("");
  const [retentionDirty, setRetentionDirty] = useState(false);
  const retentionDirtyRef = useRef(false);
  const savedPolicyRef = useRef<TrashPolicy | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);
  const [pendingMutation, setPendingMutation] = useState<"restore" | "policy" | "empty" | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const loadGenerationRef = useRef(0);
  const pendingMutationRef = useRef<"restore" | "policy" | "empty" | null>(null);

  const load = useCallback(() => {
    const generation = ++loadGenerationRef.current;
    setPageLoading(true);
    setPageError(null);
    setPolicyError(null);
    void gateway.listTrash({ after: null, limit: ASSET_PAGE_SIZE })
      .then((nextPage) => {
        if (generation === loadGenerationRef.current) {
          setPage(nextPage);
          setSelectedAssetIds((current) => {
            if (current.size === 0) return current;
            const visibleIds = new Set(nextPage.items.map((entry) => entry.asset.id));
            const next = new Set([...current].filter((id) => visibleIds.has(id)));
            return next.size === current.size ? current : next;
          });
          onCountChange?.(nextPage.totalCount);
        }
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current) setPageError(commandErrorMessage(error, "휴지통을 불러오지 못했습니다."));
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setPageLoading(false);
      });
    void gateway.getTrashPolicy()
      .then((nextPolicy) => {
        if (generation !== loadGenerationRef.current) return;
        setPolicy(nextPolicy);
        savedPolicyRef.current = nextPolicy;
        if (!retentionDirtyRef.current) setRetentionDays(nextPolicy.retentionDays?.toString() ?? "");
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current) setPolicyError(commandErrorMessage(error, "보존 기간을 불러오지 못했습니다."));
      });
  }, [gateway, onCountChange]);

  async function loadMoreAssets() {
    if (!page?.nextCursor || loadingMore || pendingMutationRef.current) return;
    const generation = loadGenerationRef.current;
    setLoadingMore(true);
    try {
      const next = await gateway.listTrash({ after: page.nextCursor, limit: ASSET_PAGE_SIZE });
      if (generation !== loadGenerationRef.current) return;
      setPage((current) => {
        if (!current) return next;
        const existing = new Set(current.items.map((item) => item.asset.id));
        return {
          ...next,
          items: [...current.items, ...next.items.filter((item) => !existing.has(item.asset.id))],
        };
      });
    } catch (error) {
      if (generation === loadGenerationRef.current) setMessage(commandErrorMessage(error, "다음 항목을 불러오지 못했습니다."));
    } finally {
      if (generation === loadGenerationRef.current) setLoadingMore(false);
    }
  }

  const loadCollections = useCallback(() => {
    const generation = ++collectionGeneration.current;
    setCollectionLoading(true);
    setCollectionError(null);
    void (gateway.listCollectionTrash?.() ?? Promise.reject(new Error("컬렉션 휴지통을 사용할 수 없습니다.")))
      .then(next => {
        if (generation !== collectionGeneration.current) return;
        setCollectionPage({ ...next, items: next.items.map(item => restoringWorks.current.has(item.workId) ? { ...item, restorePending: true } : item) });
        if (library) setCollectionTrashCount(library.root, next.hasMore ? 0 : next.items.length);
      })
      .catch(error => {
        if (generation === collectionGeneration.current) setCollectionError(commandErrorMessage(error, "컬렉션 휴지통을 불러오지 못했습니다."));
      })
      .finally(() => { if (generation === collectionGeneration.current) setCollectionLoading(false); });
  }, [gateway, library]);

  useEffect(() => {
    loadCollections();
    return () => { collectionGeneration.current++; };
  }, [loadCollections]);
  useEffect(() => gateway.subscribeCollectionsChanged?.(loadCollections), [gateway, loadCollections]);
  useEffect(() => { if (store) void store.load(); }, [store]);
  useEffect(() => {
    if (section !== "collections" && section !== "notes") return;
    const refresh = () => {
      if (document.hidden || restoringWorks.current.size) return;
      if (section === "collections") loadCollections();
      else if (store?.snapshot().unlocked) void store.sync(false);
    };
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 60_000);
    return () => { window.removeEventListener("focus", refresh); clearInterval(timer); };
  }, [section, loadCollections, store]);

  const sectionReady = section === "assets" ? page !== null || !!pageError
    : section === "collections" ? collectionPage !== null || !!collectionError
    : !store || !!notesState?.ready;
  useEffect(() => { if (sectionReady) setShownSection(section); }, [section, sectionReady]);

  function chooseSection(next: TrashSection) {
    setSection(next);
    rememberTrashSection(next);
  }

  async function restoreWork(item: CollectionTrashItem) {
    if (!collectionPage || item.restorePending || restoringWorks.current.has(item.workId)) return;
    restoringWorks.current.add(item.workId);
    collectionGeneration.current++;
    setCollectionPage(current => current && ({ ...current, items: current.items.map(row => row.workId === item.workId ? { ...row, restorePending: true } : row) }));
    setCollectionError(null);
    try {
      if (!gateway.restoreCollectionWork) throw new Error("컬렉션 복원을 사용할 수 없습니다.");
      await gateway.restoreCollectionWork(item.workId, item.entityRevision, collectionPage.libraryId, collectionPage.epoch);
      restoringWorks.current.delete(item.workId);
      loadCollections();
    } catch (error) {
      restoringWorks.current.delete(item.workId);
      setCollectionPage(current => current && ({ ...current, items: current.items.map(row => row.workId === item.workId ? { ...row, restorePending: false } : row) }));
      setCollectionError(commandErrorMessage(error, "작품을 복원하지 못했습니다."));
      setCollectionLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => { loadGenerationRef.current += 1; };
  }, [load]);
  // Remote trash/restore lands in the local replica while this view is open.
  useEffect(() => {
    const refresh = () => { if (!pendingMutationRef.current) load(); };
    window.addEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, refresh);
  }, [load]);

  function beginMutation(kind: "restore" | "policy" | "empty"): boolean {
    if (pendingMutationRef.current) return false;
    pendingMutationRef.current = kind;
    setPendingMutation(kind);
    return true;
  }

  function finishMutation() {
    pendingMutationRef.current = null;
    setPendingMutation(null);
  }

  function resetRetentionDraft(nextPolicy = savedPolicyRef.current) {
    retentionDirtyRef.current = false;
    setRetentionDirty(false);
    setRetentionDays(nextPolicy?.retentionDays?.toString() ?? "");
  }

  function toggleSelectAsset(assetId: string) {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function restore(assetId: string) {
    if (!beginMutation("restore")) return;
    try {
      await gateway.restoreAsset(assetId);
      setSelectedAssetIds((current) => {
        if (!current.has(assetId)) return current;
        const next = new Set(current);
        next.delete(assetId);
        return next;
      });
      setMessage("자산을 복원했습니다.");
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 복원하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function restoreSelected() {
    const ids = (page?.items ?? []).map((entry) => entry.asset.id).filter((id) => selectedAssetIds.has(id));
    if (ids.length === 0 || !beginMutation("restore")) return;
    try {
      await gateway.restoreAssets(ids);
      setSelectedAssetIds(new Set());
      setMessage(`${ids.length.toLocaleString()}개 자산을 복원했습니다.`);
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "선택한 자산을 복원하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function setAutomaticDeletion(enabled: boolean) {
    if (!beginMutation("policy")) return;
    const nextPolicy = { retentionDays: enabled ? validRetentionDays(retentionDays) ?? 30 : null };
    try {
      await gateway.setTrashPolicy(nextPolicy);
      setPolicy(nextPolicy);
      savedPolicyRef.current = nextPolicy;
      resetRetentionDraft(nextPolicy);
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자동 삭제 설정을 변경하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function saveRetention() {
    const days = validRetentionDays(retentionDays);
    if (days === null || !beginMutation("policy")) return;
    try {
      await gateway.setTrashPolicy({ retentionDays: days });
      setPolicy({ retentionDays: days });
      savedPolicyRef.current = { retentionDays: days };
      resetRetentionDraft(savedPolicyRef.current);
      setMessage("보존 기간을 저장했습니다.");
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "보존 기간을 저장하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function emptyTrash() {
    if (!beginMutation("empty")) return;
    try {
      const result = await gateway.emptyTrash();
      const failedCount = result.failedAssetIds.length;
      setMessage(failedCount > 0
        ? `${result.deletedCount}개 삭제, ${failedCount}개 삭제 실패했습니다.`
        : `${result.deletedCount}개를 영구 삭제했습니다.`);
      setSelectedAssetIds(new Set());
      setConfirmEmpty(false);
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "휴지통을 비우지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  const automaticDeletion = policy !== null && policy.retentionDays !== null;
  const retentionError = automaticDeletion || retentionDirty ? retentionErrorMessage(retentionDays) : undefined;
  const loadError = pageError ?? policyError;
  const mutationPending = pendingMutation !== null;
  const visibleCollectionItems = collectionPage?.items.filter(item => !privacyMode || item.type !== "av") ?? [];
  const assetItems = page?.items ?? [];
  const allAssetsSelected = assetItems.length > 0 && assetItems.every((entry) => selectedAssetIds.has(entry.asset.id));
  const selectedCount = assetItems.filter((entry) => selectedAssetIds.has(entry.asset.id)).length;

  return <section className="trash-browser" aria-label="휴지통">
    <ViewToolbar
      title="휴지통"
      chrome={{}}
      trailingAction={shownSection === "assets" ? <Button variant="danger" size="sm" onClick={() => setConfirmEmpty(true)} disabled={!page || page.totalCount === 0 || mutationPending || section !== shownSection}>휴지통 비우기</Button> : undefined}
    />
    <div className="trash-browser__tabs">
      <Tabs label="휴지통 섹션" tabs={trashTabs({ assets: page?.totalCount, collections: collectionPage?.items.length, notes: notesState?.ready ? deletedNotes.length : undefined }, { collections: collectionPage?.hasMore })} value={section} onChange={chooseSection} />
    </div>
    <div className="trash-browser__body" inert={section !== shownSection}>
      <div className="trash-browser__section" hidden={shownSection !== "assets"}>
        <details className="trash-browser__policy" onToggle={(event) => { if (event.currentTarget.open) resetRetentionDraft(); }}>
          <summary>
            보존 설정{" "}
            <span className="trash-browser__policy-summary">
              <BusyLabel busy={!policy} idle={policy && (automaticDeletion ? `${policy.retentionDays}일 후 자동 삭제` : "자동 삭제 안 함")}>설정 확인 중…</BusyLabel>
              <ChevronDownIcon className="trash-browser__policy-chevron" aria-hidden="true" />
            </span>
          </summary>
          <div className="trash-browser__policy-controls" role="group" aria-label="보존 기간 설정">
            <Checkbox checked={automaticDeletion} disabled={!policy || mutationPending} onChange={(event) => void setAutomaticDeletion(event.target.checked)}>자동 삭제</Checkbox>
            {(automaticDeletion || retentionDirty) && <div className="trash-browser__retention">
              <Field label="보존 기간" error={retentionError}>
                <TextInput type="number" min={MIN_RETENTION_DAYS} max={MAX_RETENTION_DAYS} value={retentionDays} disabled={mutationPending} onChange={(event) => { retentionDirtyRef.current = true; setRetentionDirty(true); setRetentionDays(event.target.value); }} />
              </Field>
              <div className="trash-browser__retention-actions">
                <Button variant="primary" onClick={() => void saveRetention()} disabled={Boolean(retentionError) || mutationPending}>저장</Button>
                {retentionDirty && <Button variant="ghost" onClick={() => resetRetentionDraft()} disabled={mutationPending}>취소</Button>}
              </div>
            </div>}
          </div>
        </details>
        {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
        {loadError && <div className="trash-browser__load-error" role="alert"><span>{loadError}</span><Button disabled={mutationPending} onClick={load}>다시 시도</Button></div>}
        {page && assetItems.length > 0 && (
          <div className="trash-browser__selection-bar">
            <div className="trash-browser__summary numeric">
              <span>{page.totalCount.toLocaleString()}개 · {formatBytes(page.totalBytes)}</span>
              <Button variant="quiet" size="sm" disabled={mutationPending} onClick={() => setSelectedAssetIds(allAssetsSelected ? new Set() : new Set(assetItems.map((entry) => entry.asset.id)))}>
                {allAssetsSelected ? "선택 해제" : "전체 선택"}
              </Button>
            </div>
            {selectedCount > 0 && (
              <div className="trash-browser__bulk-actions">
                <span className="trash-browser__selected-count numeric">{selectedCount.toLocaleString()}개 선택됨</span>
                <Button variant="primary" size="sm" disabled={mutationPending} onClick={() => void restoreSelected()}>선택 복원</Button>
              </div>
            )}
          </div>
        )}
        {pageLoading && !page ? <TrashAssetSkeleton /> : pageError && !page ? null : !page || assetItems.length === 0 ? <EmptyState icon={TrashIcon} title={TRASH_EMPTY} /> : <>
          <ul className="trash-browser__grid" aria-label="휴지통 에셋">
            {assetItems.map(({ asset, trashedAt, purgeAt }) => {
              const name = asset.title || asset.originalName;
              const selected = selectedAssetIds.has(asset.id);
              return <li key={asset.id} className="trash-browser__card" data-selected={selected || undefined}>
                <div className="trash-browser__card-media" onClick={() => { if (!mutationPending) toggleSelectAsset(asset.id); }}>
                  <TrashThumbnail key={`${asset.id}:${privacyMode}`} asset={asset} hidden={privacyMode} />
                  <div className="trash-browser__card-check" onClick={(event) => event.stopPropagation()}>
                    <Checkbox aria-label={`${name} 선택`} checked={selected} disabled={mutationPending} onChange={() => toggleSelectAsset(asset.id)} />
                  </div>
                </div>
                <div className="trash-browser__card-body">
                  <div className="trash-browser__copy">
                    <strong>{name}</strong>
                    <span>옮긴 날 {localDate(trashedAt)}</span>
                    <span>{purgeAt ? trashExpiry(purgeAt) : "자동 삭제 안 함"}</span>
                  </div>
                  <Button size="sm" variant="secondary" disabled={mutationPending} onClick={() => void restore(asset.id)}>복원</Button>
                </div>
              </li>;
            })}
          </ul>
          {page.nextCursor && <div className="trash-browser__more"><Button variant="ghost" disabled={loadingMore || mutationPending} onClick={() => void loadMoreAssets()}><BusyLabel busy={loadingMore} idle="더 보기">불러오는 중…</BusyLabel></Button></div>}
        </>}
      </div>
      <div className="trash-browser__section" hidden={shownSection !== "collections"}>
        {collectionError && <div className="trash-browser__load-error" role="alert"><span>{collectionError}</span><Button onClick={loadCollections}>다시 시도</Button></div>}
        {collectionLoading && !collectionPage ? <TrashSkeleton /> : !collectionPage ? null : !visibleCollectionItems.length ? <EmptyState icon={TrashIcon} title={TRASH_EMPTY} /> : <ul className="trash-browser__list" aria-label="휴지통 작품">{visibleCollectionItems.map(item => <li className="trash-browser__item" key={item.workId}>
          <TrashWorkCover gateway={gateway} workId={item.workId} name={item.name} hidden={privacyMode} />
          <div className="trash-browser__copy"><strong>{item.name}</strong><span>{KIND_LABEL[item.type]} · {trashExpiry(item.purgeAt)}</span></div>
          {item.restorePending && <Badge>대기</Badge>}
          <Button size="sm" variant="secondary" disabled={item.restorePending} aria-label={`${item.name} 복원`} onClick={() => void restoreWork(item)}>복원</Button>
        </li>)}</ul>}
      </div>
      <div className="trash-browser__section" hidden={shownSection !== "notes"}><NotesTrashSection store={store} /></div>
    </div>
    {confirmEmpty && page && <Dialog open title="휴지통 비우기" onClose={() => setConfirmEmpty(false)}><p>휴지통의 자산 {page.totalCount}개 ({formatBytes(page.totalBytes)})를 영구 삭제합니다.</p><p>이 작업은 되돌릴 수 없습니다.</p><div className="ui-dialog__actions"><Button disabled={mutationPending} onClick={() => setConfirmEmpty(false)}>취소</Button><Button variant="danger" disabled={mutationPending} onClick={() => void emptyTrash()}>영구 삭제</Button></div></Dialog>}
  </section>;
}

/** A trashed work's cached cover, fetched as bytes on demand; the icon stays until it decodes. */
function TrashWorkCover({ gateway, workId, name, hidden }: { gateway: LibraryGateway; workId: string; name: string; hidden: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (hidden || !gateway.collectionTrashCover) return;
    let cancelled = false, objectUrl: string | null = null;
    gateway.collectionTrashCover(workId).then(bytes => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes]));
      setUrl(objectUrl);
    }, () => undefined);
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [gateway, workId, hidden]);
  return <div className="trash-browser__thumbnail">{url && !hidden && url !== failedUrl ? <StableImage src={url} alt={`${name} 표지`} onError={() => setFailedUrl(url)} /> : <RectangleStackIcon aria-label={hidden ? "비공개 모드" : "표지 없음"} role="img" />}</div>;
}

function TrashAssetSkeleton() {
  return <div className="trash-browser__grid" aria-label="휴지통을 불러오는 중">{[0, 1, 2, 3].map(index => <div className="trash-browser__card" key={index}><Skeleton className="trash-browser__card-media-skeleton" label={null} /><div className="trash-browser__card-body"><Skeleton className="trash-browser__copy-skeleton" label={null} /><Skeleton className="trash-browser__restore-skeleton" label={null} /></div></div>)}</div>;
}

function TrashSkeleton() {
  return <div className="trash-browser__list" aria-label="휴지통을 불러오는 중">{[0, 1, 2].map(index => <div className="trash-browser__item" key={index}><Skeleton className="trash-browser__thumbnail" label={null} /><Skeleton className="trash-browser__copy" label={null} /><Skeleton className="trash-browser__restore-skeleton" label={null} /></div>)}</div>;
}

export function NotesTrashSection({ store }: { store: NotesStore | null }) {
  const state = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? noNotes);
  const notes = trashNotesNewestFirst(state?.notes ?? []);
  const error = state?.error ?? (state?.ready && !state.unlocked ? "메모 잠금 해제 필요" : null);
  return <>
    {error && <div className="trash-browser__load-error" role="alert"><span>{error}</span><Button onClick={() => void (state?.unlocked ? store?.sync() : store?.refresh())}>다시 시도</Button></div>}
    {store && !state?.ready ? <TrashSkeleton /> : error && !notes.length ? null : !notes.length ? <EmptyState icon={TrashIcon} title={TRASH_EMPTY} /> : <ul className="trash-browser__list" aria-label="휴지통 메모">{notes.map(note => <li key={note.id} className="trash-browser__item">
      <div className="trash-browser__thumbnail trash-browser__thumbnail--icon"><DocumentTextIcon aria-hidden="true" /></div>
      <div className="trash-browser__copy"><strong>{note.title || "제목 없는 메모"}</strong><span>옮긴 날 {displayDate(note.updatedAt)}</span></div>
      <Button size="sm" variant="secondary" disabled={state?.saving} aria-label={`${note.title || "제목 없는 메모"} 복원`} onClick={() => { store?.edit({ ...note, deleted: false }); void store?.finish(); }}>복원</Button>
    </li>)}</ul>}
  </>;
}

function validRetentionDays(value: string): number | null {
  const days = Number(value);
  return Number.isInteger(days) && days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : null;
}

function retentionErrorMessage(value: string): string | undefined {
  return validRetentionDays(value) === null ? `보존 기간은 ${MIN_RETENTION_DAYS}일에서 ${MAX_RETENTION_DAYS}일 사이여야 합니다.` : undefined;
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : displayDate(value);
}

function TrashThumbnail({ asset, hidden: requestedPrivacy }: { asset: import("../library/types").AssetSummary; hidden: boolean }) {
  const assetId = asset.id;
  const hidden = useAssetMask(asset, requestedPrivacy);
  const [failed, setFailed] = useState(false);
  return <div className="trash-browser__card-thumb">
    {hidden || failed ? <PhotoIcon aria-hidden={false} aria-label={hidden ? "비공개 모드" : "미리보기 없음"} role="img" />
      : <AssetImage asset={asset} src={trashThumbnailUrl(assetId)} alt="휴지통 자산 미리보기" loading="lazy" onError={() => setFailed(true)} />}
  </div>;
}
