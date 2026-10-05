import { useEffect } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway } from "../library/types";
import { afterLaunchSettled } from "../shared/launch/LaunchSplash";

export function useDailyLibraryMaintenance(gateway: LibraryGateway, restricted: boolean, appendMessage: (next: string) => void, refreshTrashCount: () => Promise<void>) {
  useEffect(() => {
    if (restricted) return;
    let active = true;
    const run = async () => {
      try {
        await gateway.ensureDailyBackup();
      } catch (error) {
        if (active) appendMessage(commandErrorMessage(error, "관리 정보 자동 백업에 실패했습니다."));
      }
      if (!active) return;
      try {
        const result = await gateway.purgeExpiredTrash();
        if (active && result.failedAssetIds.length > 0) {
          appendMessage(`자동 삭제하지 못한 자산이 ${result.failedAssetIds.length}개 있습니다.`);
        }
      } catch (error) {
        if (active) appendMessage(commandErrorMessage(error, "휴지통 자동 정리를 실행하지 못했습니다."));
      } finally {
        if (active) void refreshTrashCount().catch(() => undefined);
      }
    };
    const cancel = afterLaunchSettled(() => { void run(); });
    return () => { active = false; cancel(); };
  }, [appendMessage, gateway, refreshTrashCount, restricted]);
}
