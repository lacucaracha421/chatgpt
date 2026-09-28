import { useRef, type KeyboardEvent } from "react";

export type TabOption<T extends string> = {
  value: T;
  label: string;
  count?: number | string;
};

export type TabsProps<T extends string> = {
  label: string;
  tabs: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

export function Tabs<T extends string>({ className, label, onChange, tabs, value }: TabsProps<T>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = tabs.findIndex((tab) => tab.value === value);
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0;

  function move(index: number, direction: -1 | 1) {
    if (tabs.length === 0) return;
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    onChange(tabs[nextIndex].value);
    tabRefs.current[nextIndex]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move(index, 1);
    }
  }

  return (
    <div className={["ui-tabs", className].filter(Boolean).join(" ")} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          ref={(element) => { tabRefs.current[index] = element; }}
          type="button"
          className="ui-tabs__tab"
          role="tab"
          aria-selected={tab.value === value}
          aria-label={tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`}
          tabIndex={index === rovingIndex ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ui-tabs__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
