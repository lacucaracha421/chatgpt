import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type KeyboardEventHandler, type PropsWithChildren, type WheelEventHandler } from "react";
import { useBackHandler, useBackNavigationContext, useBackRequest } from "../navigation/BackNavigation";

type DialogProps = PropsWithChildren<{
  open: boolean;
  title: string;
  variant?: "default" | "medium" | "wide" | "fullscreen";
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
}>;

const SWIPE_BACK_PX = 80;
const SWIPE_BACK_COOLDOWN_MS = 800;

export function Dialog({ children, open, title, variant = "default", onKeyDown, onClose }: DialogProps) {
  const backNavigation = useBackNavigationContext();
  const requestBack = useBackRequest();
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const swipeRef = useRef({ accumulated: 0, cooldownUntil: 0 });

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpenRef.current = open;
  }, [open]);
  useBackHandler(() => { onClose(); }, 100, open);

  // Trackpad horizontal swipe = the same back affordance as a back mouse
  // button: it follows the existing back chain (or closes like Escape when
  // no chain is registered). Either horizontal direction counts — there is
  // no forward stack to preserve — but only when nothing under the cursor
  // can scroll horizontally itself.
  const swipeBack: WheelEventHandler<HTMLDivElement> = (event) => {
    const state = swipeRef.current;
    const now = performance.now();
    if (now < state.cooldownUntil) {
      state.accumulated = 0;
      return;
    }
    const { deltaX, deltaY } = event;
    if (Math.abs(deltaY) > Math.abs(deltaX) * 1.5 || deltaX === 0) {
      state.accumulated = 0;
      return;
    }
    if (Math.sign(deltaX) !== Math.sign(state.accumulated) && state.accumulated !== 0) {
      state.accumulated = 0;
    }
    let target = event.target as HTMLElement | null;
    while (target && target !== event.currentTarget) {
      if (
        target.scrollWidth > target.clientWidth + 1 &&
        ((deltaX > 0 && target.scrollLeft + target.clientWidth < target.scrollWidth - 1) ||
          (deltaX < 0 && target.scrollLeft > 1))
      ) {
        state.accumulated = 0;
        return;
      }
      target = target.parentElement;
    }
    state.accumulated += deltaX;
    if (Math.abs(state.accumulated) < SWIPE_BACK_PX) return;
    state.accumulated = 0;
    state.cooldownUntil = now + SWIPE_BACK_COOLDOWN_MS;
    if (!requestBack()) onClose();
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog__overlay" />
        <RadixDialog.Content
          className={`ui-dialog${variant === "default" ? "" : ` ui-dialog--${variant}`}`}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
          onWheel={swipeBack}
          onEscapeKeyDown={backNavigation ? (event) => {
            event.preventDefault();
            backNavigation.requestBack();
          } : undefined}
        >
          <RadixDialog.Title className="ui-dialog__title">{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
