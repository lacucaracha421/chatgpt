import { WorkloadControls } from "../app/WorkloadControls";
import { nativeWorkload } from "../app/workloadProfile";

/** Kept as a small compatibility wrapper for settings callers. */
export function LightweightModeSettings() {
  return nativeWorkload() ? <WorkloadControls /> : null;
}
