import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import { AnchoredPanel } from "./AnchoredPanel";
import { Button } from "./Button";
import { SectionLabel } from "./SectionLabel";

export type SettingsRowProps = {
  name: string;
  value?: ReactNode;
  status?: ReactNode;
  statusClassName?: string;
  tone?: string;
  control?: ReactNode;
  className?: string;
};

export function SettingsRow({ name, value, status, statusClassName, tone, control, className }: SettingsRowProps) {
  return <dl className={`settings-view__property${className ? ` ${className}` : ""}`}><dt><span>{name}</span>{value && <strong className="settings-view__value">{value}</strong>}</dt>{status && <dd className={`settings-view__status${statusClassName ? ` ${statusClassName}` : ""}`} data-tone={tone}>{status}</dd>}{control && <dd className="settings-view__inline-controls">{control}</dd>}</dl>;
}

/** The state word inside a longer status line ("연결 안 됨 · 21:45부터"): only the word takes the tone's colour. */
export function StatusWord({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className="settings-view__state" data-tone={tone}>{children}</span>;
}

/** `help` is the ⓘ text: one paragraph, or several. */
export function SettingsGroup({ title, help, children }: { title: string; help?: string | readonly string[]; children: ReactNode }) {
  const headingId = `settings-group-${title.replace(/\s+/g, "-")}`;
  return <section className="settings-view__group" aria-labelledby={headingId}>
    <SectionLabel as="h3" id={headingId} title={title} actions={help ? <HelpButton title={title} text={help} /> : undefined} />
    {children}
  </section>;
}

function HelpButton({ title, text }: { title: string; text: string | readonly string[] }) {
  const [open, setOpen] = useState(false);
  return <AnchoredPanel open={open} onOpenChange={setOpen} title={title} trigger={<Button size="icon" variant="ghost" aria-label={`${title} 도움말`}><InformationCircleIcon aria-hidden="true" /></Button>}>{(typeof text === "string" ? [text] : text).map(paragraph => <p key={paragraph}>{paragraph}</p>)}</AnchoredPanel>;
}
