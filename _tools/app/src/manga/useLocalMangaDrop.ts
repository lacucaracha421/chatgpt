import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { subscribeToTauriDrops, type NativeFileDropEvent } from "../ingestion/useFileDrop";
import { nativeDropClientPoint } from "../app/workspaceDragTargets";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway } from "../library/types";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";

type Notice = { id: string; text: string; token: string | null; failedPaths: string[] };
export function useLocalMangaDrop(gateway: LibraryGateway, enabled: boolean, target: React.RefObject<HTMLElement | null>, reload: () => Promise<void>) {
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undoing, setUndoing] = useState(false);
  const current = useRef({ gateway, enabled, target, reload });
  const noticeRef = useRef(notice);
  const mounted = useRef(true);
  const queue = useRef(Promise.resolve());
  useLayoutEffect(() => { current.current = { gateway, enabled, target, reload }; noticeRef.current = notice; });
  const dismiss = useCallback(() => {
    const token = noticeRef.current?.token;
    if (token) void current.current.gateway.dismissLocalMangaImport?.(token).catch(() => {});
    noticeRef.current = null;
    setNotice(null);
  }, []);
  useAutoDismiss(undoing ? null : notice?.id ?? null, dismiss);
  const importPaths = useCallback((paths: string[]) => {
    const owner = current.current;
    queue.current = queue.current.then(async () => {
      if (!mounted.current || !owner.gateway.importLocalManga) return;
      try {
        const result = await owner.gateway.importLocalManga(paths);
        if (!mounted.current) { if (result.undoToken) void owner.gateway.dismissLocalMangaImport?.(result.undoToken).catch(() => {}); return; }
        dismiss();
        const failures = result.failures.map(f => `${f.path.split(/[\\/]/).pop()}: ${f.message}`).join(" · ");
        const text = [`${result.count}개 작품을 가져왔습니다`, result.archivesRetained ? "압축 파일 원본은 그대로 두었습니다" : "", failures].filter(Boolean).join(" · ");
        const next = { id: crypto.randomUUID(), text, token: result.undoToken, failedPaths: result.failures.map(f => f.path) };
        noticeRef.current = next; setNotice(next);
        try { await owner.reload(); }
        catch { setNotice(n => n && { ...n, text: `${n.text} · 목록을 새로고침하지 못했습니다` }); }
      } catch (error) {
        if (mounted.current) { dismiss(); setNotice({ id: crypto.randomUUID(), text: commandErrorMessage(error, "작품을 가져오지 못했습니다"), token: null, failedPaths: paths }); }
      }
    });
  }, [dismiss]);
  const handler = useRef<(event: NativeFileDropEvent) => void>(() => {});
  handler.current = event => {
    if (event.type === "leave" || event.type === "cancel") { setOver(false); return; }
    const owner = current.current;
    if (!owner.enabled) { setOver(false); return; }
    const point = nativeDropClientPoint(event.position);
    const bounds = owner.target.current?.getBoundingClientRect();
    const inside = !!bounds && bounds.width > 0 && bounds.height > 0 && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
    setOver(inside && event.type !== "drop");
    if (inside && event.type === "drop") importPaths(event.paths);
  };
  useEffect(() => {
    mounted.current = true;
    let stop: (() => void) | undefined; let active = true;
    void subscribeToTauriDrops(event => { if (active) handler.current(event); }).then(unlisten => { if (active) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { active = false; mounted.current = false; stop?.(); const token = noticeRef.current?.token; if (token) void current.current.gateway.dismissLocalMangaImport?.(token).catch(() => {}); };
  }, []);
  useEffect(() => { if (!enabled) setOver(false); }, [enabled]);
  async function undo() {
    const token = noticeRef.current?.token; if (!token || undoing || !gateway.undoLocalMangaImport) return;
    setUndoing(true);
    try {
      const result = await gateway.undoLocalMangaImport(token);
      await reload();
      if (result.failures.length) setNotice({ id: crypto.randomUUID(), text: result.failures.map(f => f.message).join(" · "), token, failedPaths: [] });
      else dismiss();
    } catch (error) { setNotice(n => n && { ...n, id: crypto.randomUUID(), text: commandErrorMessage(error, "되돌리지 못했습니다") }); }
    finally { setUndoing(false); }
  }
  return { over, notice, undoing, undo, dismiss, retry: () => importPaths(notice?.failedPaths ?? []) };
}
