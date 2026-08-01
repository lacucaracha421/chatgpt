import type { InputHTMLAttributes, PropsWithChildren } from "react";

type ToggleProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function Toggle({ children, ...props }: PropsWithChildren<ToggleProps>) {
  return (
    <label className="ui-toggle">
      <input type="checkbox" {...props} />
      <span>{children}</span>
    </label>
  );
}
