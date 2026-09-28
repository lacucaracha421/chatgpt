import type { InputHTMLAttributes, ReactNode } from "react";

type CheckboxInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "children" | "className" | "type"> & {
  className?: string;
};

type CheckboxProps =
  | (CheckboxInputProps & { label?: never; children?: never; "aria-label": string })
  | (CheckboxInputProps & { label: ReactNode; children?: ReactNode; "aria-label"?: string })
  | (CheckboxInputProps & { label?: never; children: ReactNode; "aria-label"?: string });

export function Checkbox({ children, className, label, ...props }: CheckboxProps) {
  const input = <input {...props} type="checkbox" className={["ui-checkbox", className].filter(Boolean).join(" ")} />;
  const content = label !== undefined ? label : children;

  if (label === undefined && children === undefined) return input;

  return (
    <label className="ui-choice">
      {input}
      <span>{content}</span>
    </label>
  );
}
