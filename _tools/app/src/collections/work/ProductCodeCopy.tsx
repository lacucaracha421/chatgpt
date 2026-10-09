import { useEffect, useState } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { IconButton } from "../../shared/ui/IconButton";
import type { Fact } from "../case/CollectionCase";

/**
 * The 품번 value with its copy icon right beside it, for the 작품 정보 rows on PC and tablet.
 * Copied is shown in place: the icon turns into a check for a moment (DESIGN.md §12, no success toast).
 * `onCopy` resolves once the clipboard holds the code; a rejection leaves the copy icon as it was.
 */
export function ProductCodeCopy({ code, onCopy }: { code: string; onCopy(code: string): Promise<unknown> | void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <span className="work-code">
    <span>{code}</span>
    <IconButton className="work-code__copy" label="품번 복사" icon={copied ? CheckIcon : ClipboardDocumentIcon}
      onClick={() => { void Promise.resolve().then(() => onCopy(code)).then(() => setCopied(true), () => setCopied(false)); }} />
  </span>;
}

/** Puts the copy icon on the 품번 row of a work's fact rows; other rows pass through unchanged. */
export function withProductCodeCopy(rows: Fact[], code: string | null | undefined, onCopy: (code: string) => Promise<unknown> | void): Fact[] {
  if (!code) return rows;
  return rows.map(([label, value]) => label === "품번" ? [label, <ProductCodeCopy code={code} onCopy={onCopy} />] : [label, value]);
}
