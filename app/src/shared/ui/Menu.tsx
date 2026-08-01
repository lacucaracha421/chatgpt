import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

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
  contextTarget?: RefObject<HTMLElement | null>;
};

type MenuPosition = { left: number; top: number };

export function Menu({ contextTarget, items, label, trigger }: MenuProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const contextPointerTargetRef = useRef<EventTarget | null>(null);
  const wasOpenRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ left: 0, top: 0 });

  const enabledIndexes = items.flatMap((item, index) => (item.disabled ? [] : [index]));

  function openMenu(position: MenuPosition) {
    const firstEnabledIndex = enabledIndexes[0] ?? 0;
    setActiveIndex(firstEnabledIndex);
    setPosition(position);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
  }

  useEffect(() => {
    const target = contextTarget?.current;
    if (!target) return;

    const openFromContextTarget = (event: MouseEvent) => {
      event.preventDefault();
      contextPointerTargetRef.current = event.currentTarget;
      openMenu({ left: event.clientX, top: event.clientY });
    };
    target.addEventListener("contextmenu", openFromContextTarget);
    return () => target.removeEventListener("contextmenu", openFromContextTarget);
  });

  useEffect(() => {
    if (!open) return;
    const dismissOutsideMenu = (event: PointerEvent) => {
      if (event.target === contextPointerTargetRef.current) {
        contextPointerTargetRef.current = null;
        return;
      }
      contextPointerTargetRef.current = null;
      const target = event.target;
      if (
        target instanceof Node
        && !menuRef.current?.contains(target)
        && !triggerRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    document.addEventListener("pointerup", dismissOutsideMenu);
    return () => document.removeEventListener("pointerup", dismissOutsideMenu);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const { height, width } = menuRef.current.getBoundingClientRect();
    setPosition((current) => {
      const left = Math.max(0, Math.min(current.left, window.innerWidth - width));
      const top = Math.max(0, Math.min(current.top, window.innerHeight - height));
      return left === current.left && top === current.top ? current : { left, top };
    });
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      if (enabledIndexes.length === 0) {
        menuRef.current?.focus();
        return;
      }
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-index="${activeIndex}"]`)?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [activeIndex, open]);

  function moveFocus(direction: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const currentPosition = enabledIndexes.indexOf(activeIndex);
    const nextPosition = (currentPosition + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPosition]);
  }

  function selectActiveItem() {
    const item = items[activeIndex];
    if (!item || item.disabled) return;
    item.onSelect();
    closeMenu();
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(enabledIndexes[0] ?? 0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? 0);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectActiveItem();
        break;
      case "Escape":
        event.preventDefault();
        closeMenu();
        break;
    }
  }

  const menuStyle: CSSProperties = { left: position.left, top: position.top };

  return (
    <>
      <button
        ref={triggerRef}
        className="ui-menu__trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          const rect = triggerRef.current?.getBoundingClientRect();
          openMenu({ left: rect?.left ?? 0, top: rect?.bottom ?? 0 });
        }}
      >
        {trigger}
      </button>
      {open && (
        <div ref={menuRef} className="ui-menu" role="menu" tabIndex={-1} style={menuStyle} onKeyDown={handleMenuKeyDown}>
          {items.map((item, index) => (
            <button
              key={item.id}
              className={`ui-menu__item${item.destructive ? " ui-menu__item--destructive" : ""}`}
              type="button"
              role="menuitem"
              data-menu-index={index}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                closeMenu();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
