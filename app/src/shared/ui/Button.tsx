import type { ButtonHTMLAttributes, PropsWithChildren, Ref } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

type SharedButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  className?: string;
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
};

type ButtonProps =
  | (SharedButtonProps & { size?: Exclude<ButtonSize, "icon"> })
  | (SharedButtonProps & { size: "icon"; "aria-label": string });

export function Button({
  children,
  className,
  size = "md",
  variant = "secondary",
  ref,
  ...props
}: PropsWithChildren<ButtonProps>) {
  return (
    <button ref={ref} className={`ui-button ui-button--${variant} ui-button--${size}${className ? ` ${className}` : ""}`} {...props}>
      {children}
    </button>
  );
}
