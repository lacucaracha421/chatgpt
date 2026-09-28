import type { InputHTMLAttributes, ReactNode } from "react";

type SwitchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "children" | "className" | "role" | "type"> & {
  className?: string;
  description?: ReactNode;
};

type SwitchProps =
  | (SwitchInputProps & { label?: never; children?: never; "aria-label": string })
  | (SwitchInputProps & { label: ReactNode; children?: ReactNode; "aria-label"?: string })
  | (SwitchInputProps & { label?: never; children: ReactNode; "aria-label"?: string });

export function Switch({ children, className, description, label, ...props }: SwitchProps) {
  const content = label !== undefined ? label : children;
  const accessibleLabel = props["aria-label"] ?? (typeof content === "string" ? content : undefined);
  const input = <input {...props} aria-label={accessibleLabel} type="checkbox" role="switch" className={["ui-switch", className].filter(Boolean).join(" ")} />;

  if (label === undefined && children === undefined) return input;

  return (
    <label className="ui-choice ui-choice--switch">
      <span className="ui-choice__label">
        <span>{content}</span>
        {description !== undefined && description !== null && <span className="ui-choice__description">{description}</span>}
      </span>
      {input}
    </label>
  );
}
