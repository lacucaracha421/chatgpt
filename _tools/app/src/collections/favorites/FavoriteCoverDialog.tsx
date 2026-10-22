import { useEffect, useRef, useState } from "react";
import type { CharacterTarget } from "../../characters/api";
import type { CharacterBrowsePage } from "../../characters/hubApi";
import type { FavoriteEntry, FavoriteSet } from "../../library/types";
import { AssetGallery } from "../../assets/AssetGallery";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { AssetImage } from "../../privacy/AssetImage";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { TextInput, Field } from "../../shared/ui/TextInput";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { EmptyState } from "../../shared/ui/EmptyState";
import { browseFavoriteAssets } from "./useFavoriteCatalog";
import { isManualFavorite, representativeAsset } from "./model";
import { commandErrorMessage } from "../../library/errorMessage";
import { useLibrary } from "../../library/LibraryContext";
import { claimNativeDrop } from "../../ingestion/dropClaims";
import { subscribeToTauriDrops } from "../../ingestion/useFileDrop";
import { nativeDropClientPoint } from "../../app/workspaceDragTargets";
import { FavoritePortrait } from "./FavoritePortrait";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "tif", "tiff", "heic", "heif"];

export function FavoriteCoverDialog({ target, entry, initialPage, busy, onSave, onClose }: {
  target: CharacterTarget; entry: FavoriteEntry; initialPage: CharacterBrowsePage; busy: boolean;
  onSave(set: FavoriteSet): Promise<boolean>; onClose(): void;
}) {
  const { gateway } = useLibrary();
  const manual = isManualFavorite(entry.characterId);
  const dropArea = useRef<HTMLDivElement>(null);
  const releaseDrop = useRef<(() => void) | undefined>(undefined);
  const importing = useRef(false);
  const [importBusy, setImportBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState(() => representativeAsset(entry, target, initialPage.items[0]?.id));
  const [coverY, setCoverY] = useState(entry.coverY);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  const drag = useRef<{ pointer: number; y: number; focus: number } | null>(null);
  const { privacyMode } = usePrivacy();
  const locked = busy || importBusy;
  const importImage = async (paths: string[], clipboard?: File) => {
    if (importing.current || busy) return;
    if (!clipboard && (paths.length !== 1 || !IMAGE_EXTENSIONS.includes(paths[0].split(".").pop()?.toLowerCase() ?? ""))) {
      setError("이미지 파일 하나를 선택하세요."); return;
    }
    importing.current = true; setImportBusy(true); setError(null);
    let temporary: string | undefined;
    try {
      if (clipboard) {
        if (!gateway.stageClipboardImage || !gateway.removeClipboardImage) throw new Error("이 환경에서는 이미지 붙여넣기를 지원하지 않습니다.");
        if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"].includes(clipboard.type)) throw new Error("지원하지 않는 클립보드 이미지 형식입니다.");
        if (!clipboard.size || clipboard.size > 64 * 1024 * 1024) throw new Error("이미지는 64 MiB 이하의 비어 있지 않은 파일이어야 합니다.");
        temporary = await gateway.stageClipboardImage(clipboard.type, Array.from(new Uint8Array(await clipboard.arrayBuffer())));
      }
      const result = await gateway.ingestMedia({ sourcePath: temporary ?? paths[0], classificationId: null, sourceUrl: null, importSource: "favorite_cover", importBatchId: crypto.randomUUID() });
      if (result.status === "review_pending") { setError("비슷한 이미지 확인 후 다시 선택하세요."); return; }
      if (result.status === "added" && result.asset.media.kind !== "image") { setError("이미지 파일을 선택하세요."); return; }
      setSelected(result.status === "added" ? result.asset.id : result.existingAssetId); setCoverY(50);
    } catch (reason) { setError(commandErrorMessage(reason, "이미지를 가져오지 못했습니다.")); }
    finally {
      try { if (temporary) await gateway.removeClipboardImage!(temporary); }
      catch (reason) { setError(commandErrorMessage(reason, "붙여넣기 임시 파일을 삭제하지 못했습니다.")); }
      importing.current = false; setImportBusy(false);
    }
  };
  const live = useRef({ importImage, locked }); live.current = { importImage, locked };
  useEffect(() => {
    if (!manual) return;
    const paste = (event: ClipboardEvent) => {
      const dialog = dropArea.current?.closest(".ui-dialog");
      if (!(event.target instanceof Node) || !dialog?.contains(event.target)) return;
      const item = Array.from(event.clipboardData?.items ?? []).find(item => item.kind === "file" && item.type.startsWith("image/"));
      const image = item?.getAsFile();
      if (!image) return;
      event.preventDefault(); event.stopPropagation();
      if (!live.current.locked) void live.current.importImage([], image);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [manual]);
  useEffect(() => {
    if (!manual) return;
    let active = true, stop: (() => void) | undefined;
    void subscribeToTauriDrops(event => {
      if (!active) return;
      if (event.type === "leave" || event.type === "cancel") { setOver(false); return; }
      const box = dropArea.current?.getBoundingClientRect(), point = nativeDropClientPoint(event.position);
      const inside = !!box && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
      setOver(inside && event.type !== "drop" && !live.current.locked);
      if (inside && event.type === "drop" && !live.current.locked) void live.current.importImage(event.paths);
    }).then(unlisten => { if (active) stop = unlisten; else unlisten(); }).catch(reason => {
      if (active) setError(commandErrorMessage(reason, "파일 놓기를 시작하지 못했습니다. 파일 선택을 이용하세요."));
    });
    return () => { active = false; stop?.(); };
  }, [manual]);
  const choose = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, directory: false, title: "대표 이미지 선택", filters: [{ name: "이미지", extensions: IMAGE_EXTENSIONS }] });
      if (path) await importImage(Array.isArray(path) ? path : [path]);
    } catch (reason) { setError(commandErrorMessage(reason, "이미지를 선택하지 못했습니다.")); }
  };
  const loadMore = async () => {
    if (!page.nextCursor || loading.current) return;
    loading.current = true;
    try {
      const next = await browseFavoriteAssets(target, page.nextCursor);
      setPage(previous => ({ ...next, items: [...previous.items, ...next.items] })); setError(null);
    } catch (reason) { setError(commandErrorMessage(reason, "에셋을 불러오지 못했습니다.")); }
    finally { loading.current = false; }
  };
  return <Dialog open title="대표 이미지 바꾸기" variant="wide" onClose={() => { if (!locked) onClose(); }}>
    <div className="favorite-cover-dialog">
      {manual ? <div ref={element => {
        dropArea.current = element; releaseDrop.current?.();
        // Own the whole dialog so a drop over its preview cannot reach the app-wide import.
        const dialog = element?.closest<HTMLElement>(".ui-dialog");
        releaseDrop.current = dialog ? claimNativeDrop(dialog) : undefined;
      }} className="favorite-cover-drop" data-over={over || undefined} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
        <p>이미지를 끌어다 놓거나 붙여넣기 (Ctrl+V), 또는 파일 선택</p>
        <Button variant="quiet" disabled={locked} onClick={() => void choose()}>파일 선택</Button>
        <span className="favorite-meta" role="status"><BusyLabel busy={importBusy} delay={400}>가져오는 중</BusyLabel></span>
      </div> : <div className="favorite-cover-dialog__gallery"><AssetGallery items={page.items} groupDates={false} scopeKey={`favorite-cover:${target.id}`} selectedAssetIds={new Set(selected ? [selected] : [])}
        privacyMode={privacyMode} totalCount={page.totalCount} onSelectionGesture={asset => { setSelected(asset.id); setCoverY(50); }} onOpen={asset => { setSelected(asset.id); setCoverY(50); }}
        hasNextPage={!!page.nextCursor} onLoadNextPage={() => void loadMore()} />
        {!page.totalCount && <EmptyState inline title="선택할 수 있는 이미지가 없습니다" />}
      </div>}
      <div className="favorite-cover-dialog__side">
        <div className="favorite-cover-preview" onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, y: event.clientY, focus: coverY };
        }} onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointer !== event.pointerId) return;
          setCoverY(Math.max(0, Math.min(100, start.focus - (event.clientY - start.y) / event.currentTarget.clientHeight * 100)));
        }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          {manual ? <FavoritePortrait coverId={selected} coverY={coverY} name={entry.name} seriesName={entry.seriesName} alt="카드 미리보기" />
            : selected && !privacyMode && <AssetImage src={thumbnailUrl(selected)} alt="카드 미리보기" draggable={false} style={{ objectPosition: `50% ${coverY}%` }} />}
        </div>
        <p className="favorite-meta">미리보기를 끌어 잘리는 위치 조절</p>
        <Field label="세로 위치 · %"><TextInput type="range" min={0} max={100} value={coverY} onChange={event => setCoverY(Number(event.target.value))} /></Field>
      </div>
    </div>
    {error && <p role="alert">{error}<Button variant="quiet" disabled={locked} onClick={() => void (manual ? choose() : loadMore())}>다시 시도</Button></p>}
    <div className="favorite-editor__foot"><Button variant="ghost" disabled={locked} onClick={onClose}>취소</Button><Button variant="primary" disabled={locked || !selected} onClick={() => void onSave({ coverAssetId: selected, coverY }).then(saved => { if (saved) onClose(); })}><BusyLabel busy={busy} delay={400} idle="바꾸기">저장 중</BusyLabel></Button></div>
  </Dialog>;
}
