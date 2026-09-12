import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { Fragment, type PropsWithChildren, type ReactElement } from "react";
import type { MenuItem } from "./Menu";

export type ContextMenuItem = MenuItem & { children?: MenuItem[] };
type ContextMenuProps = PropsWithChildren<{
  children: ReactElement;
  items: ContextMenuItem[];
}>;

export function ContextMenu({ children, items }: ContextMenuProps) {
  return (
    <RadixContextMenu.Root modal={false}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content className="ui-menu">
          {items.map((item, index) => <Fragment key={item.id}>
            {item.destructive && !items[index - 1]?.destructive && <RadixContextMenu.Separator className="asset-context-menu__separator" />}
            {item.children ? <RadixContextMenu.Sub>
              <RadixContextMenu.SubTrigger className="ui-menu__item" disabled={item.disabled}>{item.label}<span aria-hidden="true"> ›</span></RadixContextMenu.SubTrigger>
              <RadixContextMenu.Portal><RadixContextMenu.SubContent className="ui-menu asset-context-menu__destinations">
                {item.children.map((child) => <RadixContextMenu.Item key={child.id} asChild disabled={child.disabled} onSelect={child.onSelect}><button type="button" className="ui-menu__item" disabled={child.disabled}>{child.label}</button></RadixContextMenu.Item>)}
              </RadixContextMenu.SubContent></RadixContextMenu.Portal>
            </RadixContextMenu.Sub> : (
            <RadixContextMenu.Item
              key={item.id}
              asChild
              disabled={item.disabled}
              onSelect={item.onSelect}
            >
              <button
                type="button"
                className={`ui-menu__item${item.destructive ? " ui-menu__item--destructive" : ""}`}
                disabled={item.disabled}
              >
                {item.label}
              </button>
            </RadixContextMenu.Item>
          )}</Fragment>)}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
