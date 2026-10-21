import { useEffect, useRef } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway } from "../library/types";
import { afterLaunchSettled } from "../shared/launch/LaunchSplash";

export function useDailyLibraryMaintenance(gateway: LibraryGateway, restricted: boolean, appendMessage: (next: string) => void, refreshTrashCount: () => Promise<void>) {
  const failures = useRef({ backup: false, trash: false });
  useEffect(() => {
    if (restricted) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        await gateway.ensureDailyBackup();
        if (active) failures.current.backup = false;
      } catch (error) {
        if (active && !failures.current.backup) appendMessage(commandErrorMessage(error, "관리 정보 자동 백업에 실패했습니다."));
        if (active) failures.current.backup = true;
      }
      if (!active) return;
      try {
        const result = await gateway.purgeExpiredTrash();
        if (active && result.failedAssetIds.length > 0 && !failures.current.trash) {
          appendMessage(`자동 삭제하지 못한 자산이 ${result.failedAssetIds.length}개 있습니다.`);
        }
        if (active) failures.current.trash = result.failedAssetIds.length > 0;
      } catch (error) {
        if (active && !failures.current.trash) appendMessage(commandErrorMessage(error, "휴지통 자동 정리를 실행하지 못했습니다."));
        if (active) failures.current.trash = true;
      } finally {
        if (active) {
          void refreshTrashCount().catch(() => undefined);
          timer = setTimeout(() => { void run(); }, 60 * 60 * 1000);
        }
      }
    };
    const cancel = afterLaunchSettled(() => { void run(); });
    return () => { active = false; cancel(); clearTimeout(timer); };
  }, [appendMessage, gateway, refreshTrashCount, restricted]);
}
