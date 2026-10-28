import { useState } from "react";
import type { CollectionSummary, CollectionType, LibraryGateway } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { useMotionSurface } from "../shared/ui/useMotionSurface";
import { restoreCollectionByName } from "./restoreCollection";

export function RestoreCollectionAction({gateway, type, name, onRestored, onBusyChange}: {gateway: LibraryGateway; type: CollectionType; name: string; onRestored(work: CollectionSummary): void | Promise<void>; onBusyChange?(busy: boolean): void}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ref = useMotionSurface("menu");
  return <div ref={ref}>
    <Button disabled={busy} onClick={async () => {
      setBusy(true); setError(""); onBusyChange?.(true);
      try { await onRestored(await restoreCollectionByName(gateway, type, name)); }
      catch (reason) { setError(commandErrorMessage(reason, "복원하지 못했습니다.")); }
      finally { setBusy(false); onBusyChange?.(false); }
    }}><BusyLabel busy={busy} idle="휴지통에서 복원">복원하는 중</BusyLabel></Button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
