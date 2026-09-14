import { useEffect, useState } from "react";

/** Let each read publish before consuming the latest background refresh request.
 * Scope changes and explicit mutations retain their own immediate invalidation.
 */
export function useCoalescedRefreshVersion(version: number, loading: boolean): number {
  const [applied, setApplied] = useState(version);
  useEffect(() => {
    if (!loading) setApplied(version);
  }, [version, loading]);
  return applied;
}
