import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { useMotionSurface } from "./useMotionSurface";
import { Fragment, type PropsWithChildren, type ReactElement } from "react";
import type { MenuItem } from "./Menu";

/** `separatorBefore` draws a divider above the item; `shortcut` is shown dimmed at the end of the row (a hint, not a binding). */
export type ContextMenuItem = MenuItem & { children?: MenuItem[]; separatorBefore?: boolean; shortcut?: string };
type ContextMenuProps = PropsWithChildren<{
  children: ReactElement;
  items: ContextMenuItem[];
}>;

export function ContextMenu({ children, items }: ContextMenuProps) {
  const surfaceRef = useMotionSurface("menu");
  return (
    <RadixContextMenu.Root modal={false}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content ref={surfaceRef} className="ui-menu">
          {items.map((item, index) => <Fragment key={item.id}>
            {((item.destructive && !items[index - 1]?.destructive) || (item.separatorBefore && index > 0)) && <RadixContextMenu.Separator className="asset-context-menu__separator" />}
            {item.children ? <RadixContextMenu.Sub>
              <RadixContextMenu.SubTrigger className="ui-menu__item" disabled={item.disabled}>{item.label}<span aria-hidden="true"> ›</span></RadixContextMenu.SubTrigger>
              <RadixContextMenu.Portal><SubMenuContent>
                {item.children.map((child) => <RadixContextMenu.Item key={child.id} asChild disabled={child.disabled} onSelect={child.onSelect}><button type="button" className="ui-menu__item" disabled={child.disabled}>{child.label}</button></RadixContextMenu.Item>)}
              </SubMenuContent></RadixContextMenu.Portal>
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
                aria-keyshortcuts={item.shortcut?.replace("←", "ArrowLeft").replace("→", "ArrowRight")}
              >
                {item.label}
                {item.shortcut && <span className="ui-menu__shortcut" aria-hidden="true">{item.shortcut}</span>}
              </button>
            </RadixContextMenu.Item>
          )}</Fragment>)}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}

function SubMenuContent({ children }: PropsWithChildren) {
  const surfaceRef = useMotionSurface("menu");
  return <RadixContextMenu.SubContent ref={surfaceRef} className="ui-menu asset-context-menu__destinations">{children}</RadixContextMenu.SubContent>;
}
