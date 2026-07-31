import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type {
  AssetCursor,
  AssetSummary,
  ClassificationEntry,
} from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Toast } from "../shared/ui/Toast";
import { buildJustifiedRows } from "./justifiedRows";
import { assetUrl, thumbnailUrl } from "./mediaUrl";

const PAGE_SIZE = 100;
const TARGET_ROW_HEIGHT = 180;
const VIRTUAL_OVERSCAN_ROWS = 3;
const NEXT_PAGE_THRESHOLD_ROWS = 5;

type AssetGalleryProps = {
  items: AssetSummary[];
  classifications: ClassificationEntry[];
  directOnly: boolean;
  onDirectOnlyChange: (directOnly: boolean) => void;
  hasNextPage?: boolean;
  onLoadNextPage?: () => void;
};

export function AssetBrowser({
  classificationId,
  classifications,
}: {
  classificationId: string | null;
  classifications: ClassificationEntry[];
}) {
  const { gateway } = useLibrary();
  const [directOnly, setDirectOnly] = useState(false);
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<AssetCursor | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const generationRef = useRef(0);
  const loadingRef = useRef(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    loadingRef.current = true;
    setItems([]);
    setNextCursor(null);
    setMessage(null);
    void gateway
      .listAssets({
        classificationId,
        directOnly,
        after: null,
        limit: PAGE_SIZE,
      })
      .then((page) => {
        if (generation !== generationRef.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (generation === generationRef.current) {
          setMessage(commandErrorMessage(error, "자산을 불러오지 못했습니다."));
        }
      })
      .finally(() => {
        if (generation === generationRef.current) {
          loadingRef.current = false;
        }
      });
    return () => {
      if (generation === generationRef.current) {
        generationRef.current += 1;
      }
    };
  }, [classificationId, directOnly, gateway]);

  const loadNextPage = useCallback(() => {
    if (!nextCursor || loadingRef.current) return;
    const generation = generationRef.current;
    const cursor = nextCursor;
    loadingRef.current = true;
    void gateway
      .listAssets({
        classificationId,
        directOnly,
        after: cursor,
        limit: PAGE_SIZE,
      })
      .then((page) => {
        if (generation !== generationRef.current) return;
        setItems((current) => [...current, ...page.items]);
        setNextCursor(page.nextCursor);
        setMessage(null);
      })
      .catch((error: unknown) => {
        if (generation === generationRef.current) {
          setMessage(commandErrorMessage(error, "자산을 불러오지 못했습니다."));
        }
      })
      .finally(() => {
        if (generation === generationRef.current) {
          loadingRef.current = false;
        }
      });
  }, [classificationId, directOnly, gateway, nextCursor]);

  return (
    <section className="asset-browser" aria-label="자산">
      {message && <Toast>{message}</Toast>}
      <AssetGallery
        items={items}
        classifications={classifications}
        directOnly={directOnly}
        onDirectOnlyChange={setDirectOnly}
        hasNextPage={nextCursor !== null}
        onLoadNextPage={loadNextPage}
      />
    </section>
  );
}

export function AssetGallery({
  items,
  classifications,
  directOnly,
  onDirectOnlyChange,
  hasNextPage = false,
  onLoadNextPage,
}: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, gap } = useGalleryMetrics(scrollRef);
  const rows = useMemo(
    () => buildJustifiedRows(items, width, TARGET_ROW_HEIGHT, gap),
    [gap, items, width],
  );
  const [selectedAsset, setSelectedAsset] = useState<AssetSummary | null>(null);
  useEffect(() => {
    if (
      selectedAsset &&
      !items.some((asset) => asset.id === selectedAsset.id)
    ) {
      setSelectedAsset(null);
    }
  }, [items, selectedAsset]);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.height ?? TARGET_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.items[0]?.id ?? index,
    gap,
    overscan: VIRTUAL_OVERSCAN_ROWS,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (
      hasNextPage &&
      onLoadNextPage &&
      last &&
      last.index >= rows.length - NEXT_PAGE_THRESHOLD_ROWS
    ) {
      onLoadNextPage();
    }
  }, [hasNextPage, onLoadNextPage, rows.length, virtualRows]);

  return (
    <>
      <div className="asset-gallery__toolbar">
        <label>
          <input
            type="checkbox"
            checked={directOnly}
            onChange={(event) => onDirectOnlyChange(event.target.checked)}
          />
          이 항목만
        </label>
      </div>
      <div ref={scrollRef} className="asset-gallery__scroll">
        <div
          className="asset-gallery__virtual-space"
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                className="asset-gallery__row"
                style={{
                  gap,
                  height: row.height,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.items.map((asset) => {
                  const alt = asset.title || asset.originalName;
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      className="asset-gallery__asset"
                      style={{ width: asset.width, height: row.height }}
                      onClick={() => setSelectedAsset(asset)}
                      aria-label={`${alt} 자세히 보기`}
                    >
                      <img src={thumbnailUrl(asset.id)} alt={alt} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <AssetDetailDialog
        asset={selectedAsset}
        classifications={classifications}
        onClose={() => setSelectedAsset(null)}
      />
    </>
  );
}

export function AssetDetailDialog({
  asset,
  classifications,
  onClose,
}: {
  asset: AssetSummary | null;
  classifications: ClassificationEntry[];
  onClose: () => void;
}) {
  const { gateway } = useLibrary();
  const [classificationsState, setClassificationsState] = useState<{
    assetId: string | null;
    status: "idle" | "loading" | "loaded" | "error";
    selectedIds: string[];
  }>({ assetId: null, status: "idle", selectedIds: [] });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const identityRef = useRef({ assetId: null as string | null, generation: 0 });
  const assetId = asset?.id ?? null;
  if (identityRef.current.assetId !== assetId) {
    identityRef.current = {
      assetId,
      generation: identityRef.current.generation + 1,
    };
  }
  const generation = identityRef.current.generation;

  useEffect(() => {
    setClassificationsState({
      assetId,
      status: assetId ? "loading" : "idle",
      selectedIds: [],
    });
    setSaving(false);
    setMessage(null);
    if (!assetId) return;
    const request = { assetId, generation };
    void gateway
      .getAssetClassifications(assetId)
      .then((ids) => {
        if (isCurrentAsset(identityRef, request)) {
          setClassificationsState({
            assetId,
            status: "loaded",
            selectedIds: ids,
          });
        }
      })
      .catch((error: unknown) => {
        if (isCurrentAsset(identityRef, request)) {
          setClassificationsState({
            assetId,
            status: "error",
            selectedIds: [],
          });
          setMessage(commandErrorMessage(error, "분류를 불러오지 못했습니다."));
        }
      });
  }, [assetId, gateway, generation]);

  if (!asset) return null;
  const alt = asset.title || asset.originalName;
  const loaded =
    classificationsState.assetId === asset.id &&
    classificationsState.status === "loaded";
  const selectedIds =
    classificationsState.assetId === asset.id
      ? classificationsState.selectedIds
      : [];

  function close() {
    identityRef.current = {
      assetId: null,
      generation: identityRef.current.generation + 1,
    };
    onClose();
  }

  async function saveClassifications() {
    if (!asset || !loaded || saving) return;
    const request = {
      assetId: asset.id,
      generation: identityRef.current.generation,
    };
    setSaving(true);
    setMessage(null);
    try {
      await gateway.setAssetClassifications(
        asset.id,
        classifications
          .filter((entry) => selectedIds.includes(entry.id))
          .map((entry) => entry.id),
      );
      if (isCurrentAsset(identityRef, request)) close();
    } catch (error) {
      if (isCurrentAsset(identityRef, request)) {
        setMessage(commandErrorMessage(error, "분류를 저장하지 못했습니다."));
      }
    } finally {
      if (isCurrentAsset(identityRef, request)) setSaving(false);
    }
  }

  return (
    <Dialog open title={alt} onClose={close}>
      <div className="asset-detail">
        <img className="asset-detail__image" src={assetUrl(asset.id)} alt={alt} />
        <fieldset
          disabled={!loaded || saving}
          className="asset-detail__classifications"
        >
          <legend>분류</legend>
          {classifications.map((entry) => (
            <label key={entry.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(entry.id)}
                onChange={(event) =>
                  setClassificationsState((current) => ({
                    ...current,
                    selectedIds: event.target.checked
                      ? [...current.selectedIds, entry.id]
                      : current.selectedIds.filter((id) => id !== entry.id),
                  }))
                }
              />
              {entry.name}
            </label>
          ))}
        </fieldset>
        {message && <Toast>{message}</Toast>}
        <div className="ui-dialog__actions">
          <Button type="button" onClick={close}>
            닫기
          </Button>
          <Button
            type="button"
            disabled={!loaded || saving}
            onClick={() => void saveClassifications()}
          >
            분류 저장
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function isCurrentAsset(
  identityRef: React.RefObject<{
    assetId: string | null;
    generation: number;
  }>,
  request: { assetId: string; generation: number },
): boolean {
  return (
    identityRef.current?.assetId === request.assetId &&
    identityRef.current.generation === request.generation
  );
}

function useGalleryMetrics(ref: React.RefObject<HTMLElement | null>) {
  const [metrics, setMetrics] = useState({ width: 0, gap: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => {
      const gap = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--space-2"),
      );
      setMetrics({
        width,
        gap: Number.isFinite(gap) ? gap : 0,
      });
    };
    update(element.clientWidth);
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => {
      update(entry?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return metrics;
}
