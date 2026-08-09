import * as RadixContextMenu from "@radix-ui/react-context-menu";
import type { PropsWithChildren, ReactElement } from "react";
import type { MenuItem } from "./Menu";

type ContextMenuProps = PropsWithChildren<{
  children: ReactElement;
  items: MenuItem[];
}>;

export function ContextMenu({ children, items }: ContextMenuProps) {
  return (
    <RadixContextMenu.Root modal={false}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content className="ui-menu">
          {items.map((item) => (
            <RadixContextMenu.Item
              key={item.id}
              className={`ui-menu__item${item.destructive ? " ui-menu__item--destructive" : ""}`}
              disabled={item.disabled}
              onSelect={item.onSelect}
            >
              {item.label}
            </RadixContextMenu.Item>
          ))}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
