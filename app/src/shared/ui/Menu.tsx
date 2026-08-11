import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

export type MenuItem = {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type MenuProps = {
  label: string;
  items: MenuItem[];
  trigger: ReactNode;
};

export function Menu({ items, label, trigger }: MenuProps): ReactNode {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button className="ui-menu__trigger" type="button" aria-label={label}>
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ui-menu" align="start" sideOffset={4}>
          {items.map((item) => (
            <DropdownMenu.Item
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
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
