import { useRef, type KeyboardEvent } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

export function SegmentedControl<T extends string>({ className, label, onChange, options, value }: SegmentedControlProps<T>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0;

  function move(index: number, direction: -1 | 1) {
    if (options.length === 0) return;
    const nextIndex = (index + direction + options.length) % options.length;
    onChange(options[nextIndex].value);
    buttonRefs.current[nextIndex]?.focus();
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
    <div className={["ui-segmented", className].filter(Boolean).join(" ")} role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { buttonRefs.current[index] = element; }}
          type="button"
          className="ui-segmented__cell"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === rovingIndex ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
