import { cloneElement, type HTMLAttributes, type ReactElement, type RefCallback } from "react";
import { useMotionSurface } from "./useMotionSurface";

/** The inert paint snapshot exits while nested React portals and their input handlers close. */
export function MotionPresence({ open, children }: { open: boolean; children: ReactElement }) {
  const motionRef = useMotionSurface("selection");
  if (!open) return null;
  return <div className="ui-selection-presence">
    {cloneElement(children as ReactElement<HTMLAttributes<HTMLElement> & { ref?: RefCallback<HTMLElement>; "data-state"?: string }>, { ref: motionRef, "data-state": "open" })}
  </div>;
}
