import { ConnectionStatusBlock } from "../layout/ConnectionStatusBlock";
import { StatusCenter, type StatusCenterProps } from "../layout/StatusCenter";
import type { LibraryGateway } from "../library/types";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "./useCloudProblems";

// Owns the cloud snapshot so each progress event re-renders only the status indicator, not the workspace.
export function CloudStatusCenter({ gateway, libraryRoot, onOpenChange, ...props }: Omit<StatusCenterProps, "cloud" | "authorityHealth"> & { gateway: LibraryGateway; libraryRoot: string }) {
  const authority = useAuthoritySyncHealth(gateway, libraryRoot);
  const cloud = useCloudSyncStatus(gateway, libraryRoot);
  return <StatusCenter {...props} cloud={cloud} authorityHealth={authority.health}
    connections={(go) => <ConnectionStatusBlock gateway={gateway} cloud={cloud} authorityHealth={authority.health} onNavigate={go} />}
    onOpenChange={(open) => { if (open) authority.refresh(); onOpenChange?.(open); }} />;
}

