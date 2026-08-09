import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";

type TooltipProps = {
  children: ReactElement;
  content: string;
  side?: "top" | "right" | "bottom" | "left";
};

export function Tooltip({ children, content, side = "top" }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={0}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="ui-tooltip" side={side} sideOffset={6}>
            {content}
            <RadixTooltip.Arrow className="ui-tooltip__arrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
