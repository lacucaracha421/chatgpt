import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CheckIcon } from "@heroicons/react/20/solid";
import { useRef, useState, type ReactNode } from "react";

export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  /**
   * Standalone checkable item (rendered as menuitemcheckbox). Only used when
   * `group` is absent; `selected` keeps its legacy visual-only meaning there.
   */
  checked?: boolean;
  /**
   * Radio group id. Consecutive items sharing a group render as
   * menuitemradio entries where `selected` marks the active option.
   */
  group?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type MenuProps = {
  label: string;
  items: MenuItem[];
  trigger: ReactNode;
  disabled?: boolean;
  triggerClassName?: string;
};

export function Menu({ items, label, trigger, disabled = false, triggerClassName }: MenuProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelOwner, setPanelOwner] = useState<string | undefined>();
  return (
    <DropdownMenu.Root modal={false} onOpenChange={(open) => setPanelOwner(open ? triggerRef.current?.closest("[data-workspace-popover]")?.getAttribute("data-workspace-popover") ?? undefined : undefined)}>
      <DropdownMenu.Trigger asChild>
        <button ref={triggerRef} className={`ui-menu__trigger${triggerClassName ? ` ${triggerClassName}` : ""}`} type="button" aria-label={label} aria-description={label} disabled={disabled}>
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ui-menu" data-panel-owner={panelOwner} align="start" sideOffset={4}>
          {renderMenuItems(items)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function renderMenuItems(items: MenuItem[]): ReactNode {
  const rows: ReactNode[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.group === undefined) {
      rows.push(<MenuRow key={item.id} item={item} />);
      index += 1;
      continue;
    }
    const group: MenuItem[] = [];
    while (index < items.length && items[index]!.group === item.group) {
      group.push(items[index]!);
      index += 1;
    }
    const active = group.find((entry) => entry.selected)?.id ?? "";
    rows.push(
      <DropdownMenu.RadioGroup
        key={`group-${item.group}`}
        value={active}
        onValueChange={(value) => group.find((entry) => entry.id === value)?.onSelect()}
      >
        {group.map((entry) => (
          <DropdownMenu.RadioItem
            key={entry.id}
            value={entry.id}
            disabled={entry.disabled}
            className={`ui-menu__item${entry.destructive ? " ui-menu__item--destructive" : ""}`}
          >
            {entry.icon && <span className="ui-menu__item-icon" aria-hidden="true">{entry.icon}</span>}
            <span className="ui-menu__item-label">{entry.label}</span>
            <DropdownMenu.ItemIndicator className="ui-menu__item-check">
              <CheckIcon aria-hidden="true" />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>,
    );
  }
  return rows;
}

function MenuRow({ item }: { item: MenuItem }): ReactNode {
  if (item.checked !== undefined) {
    return (
      <DropdownMenu.CheckboxItem
        checked={item.checked}
        disabled={item.disabled}
        onCheckedChange={() => item.onSelect()}
        className={`ui-menu__item${item.destructive ? " ui-menu__item--destructive" : ""}`}
      >
        {item.icon && <span className="ui-menu__item-icon" aria-hidden="true">{item.icon}</span>}
        <span className="ui-menu__item-label">{item.label}</span>
        <DropdownMenu.ItemIndicator className="ui-menu__item-check">
          <CheckIcon aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </DropdownMenu.CheckboxItem>
    );
  }
  return (
    <DropdownMenu.Item
      key={item.id}
      asChild
      disabled={item.disabled}
      onSelect={item.onSelect}
    >
      <button
        type="button"
        data-selected={item.selected || undefined}
        className={`ui-menu__item${item.destructive ? " ui-menu__item--destructive" : ""}`}
        disabled={item.disabled}
      >
        {item.icon && <span className="ui-menu__item-icon" aria-hidden="true">{item.icon}</span>}
        <span className="ui-menu__item-label">{item.label}</span>
        {item.selected && <CheckIcon className="ui-menu__item-check" aria-hidden="true" />}
      </button>
    </DropdownMenu.Item>
  );
}
