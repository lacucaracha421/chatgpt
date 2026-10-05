import type { ButtonHTMLAttributes, ComponentType, MouseEvent, ReactNode, Ref, SVGProps } from "react";
import { popToggle } from "../motion/togglePop";
import { Button } from "./Button";

export type IconGlyph = ComponentType<SVGProps<SVGSVGElement>>;

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-pressed" | "children" | "className" | "onClick" | "type"> & {
  label: string;
  icon: IconGlyph;
  /** The glyph while on; DESIGN.md "Icons and rows": a solid icon only for an on state. */
  activeIcon?: IconGlyph;
  /** Set for an on/off toggle (aria-pressed); leave undefined for a plain action. */
  active?: boolean;
  /** On colour: the accent, or --color-heart for 좋아요. */
  tone?: "accent" | "heart";
  /** Affection toggles (좋아요, bookmark/관심, 쇼케이스, AV favorite) play the toggle pop (DESIGN.md §10). */
  pop?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  /** Marks drawn over the glyph, such as a pending dot or a screen-reader reason; never a text label. */
  children?: ReactNode;
  onClick(event: MouseEvent<HTMLButtonElement>): void;
};

/**
 * The one icon-only action and on/off icon toggle for PC and tablet. It is never a submit
 * button: inside a search form (the clear X) it would otherwise become the form's default
 * button, so the keyboard Search/Enter key would activate it and wipe the query instead of
 * searching. Pressed is one shared style: the on colour and the solid glyph, no face.
 */
export function IconButton({ label, icon: Icon, activeIcon, active, tone = "accent", pop = false, className, onClick, children, ...props }: IconButtonProps) {
  const Glyph = active && activeIcon ? activeIcon : Icon;
  const classes = ["ui-icon-button", tone === "heart" ? "ui-icon-button--heart" : "", className].filter(Boolean).join(" ");
  return <Button {...props} type="button" size="icon" variant="ghost" className={classes} aria-label={label} aria-pressed={active}
    onClick={(event) => { if (pop && active !== undefined) popToggle(event.currentTarget, !active); onClick(event); }}>
    <Glyph aria-hidden="true" />{children}
  </Button>;
}
