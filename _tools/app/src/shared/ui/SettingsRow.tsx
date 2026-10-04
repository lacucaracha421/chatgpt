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

export function SettingsGroup({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return <section className="settings-view__group" aria-labelledby={`settings-group-${title}`}>
    <SectionLabel as="h3" id={`settings-group-${title}`} title={title} actions={help ? <HelpButton title={title} text={help} /> : undefined} />
    {children}
  </section>;
}

function HelpButton({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return <AnchoredPanel open={open} onOpenChange={setOpen} title={title} trigger={<Button size="icon" variant="ghost" aria-label={`${title} 도움말`}><InformationCircleIcon aria-hidden="true" /></Button>}><p>{text}</p></AnchoredPanel>;
}
