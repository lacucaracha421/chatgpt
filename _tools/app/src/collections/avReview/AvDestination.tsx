import { MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../shared/ui/Button";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { Field, TextInput } from "../../shared/ui/TextInput";

export type DestinationRow = {
  id: string;
  name: string;
  /** `2022 · 표지 3면` */
  meta: string | null;
  thumbUrl: string | null;
  /** Shown instead of the meta, in the danger colour, when the row cannot take this candidate. */
  warning?: string | null;
};

export const NEW_DESTINATION = "new";

/** Where the candidate goes: each collection with this product code, a new one, or another collection. */
export function AvDestination({ rows, value, onChange, newName, onNewName, onOther, otherOpen, otherPanel, privacy, disabled = false }: {
  rows: DestinationRow[];
  /** A row id, `new`, or null while several collections match and none was chosen. */
  value: string | null;
  onChange(id: string): void;
  newName: string;
  onNewName(name: string): void;
  onOther(): void;
  otherOpen: boolean;
  otherPanel?: ReactNode;
  privacy: boolean;
  disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  const radios = () => [...group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []];
  const focusable = value ?? rows[0]?.id ?? NEW_DESTINATION;
  // Arrow keys move inside the group; Space or Enter chooses (a choice can reload the candidate).
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = radios();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    all[(at + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  }
  const row = (id: string, thumb: ReactNode, name: string, meta: string | null, warning?: string | null) => {
    const chosen = value === id;
    return <button key={id} type="button" role="radio" aria-checked={chosen} tabIndex={focusable === id ? 0 : -1} disabled={disabled}
      className={`av-dest__row${chosen ? " is-current" : ""}`} onClick={() => onChange(id)}>
      {thumb}
      <span className="av-dest__text">
        <span className="av-dest__name">{name}</span>
        {warning ? <small className="av-dest__warning">{warning}</small> : meta ? <small>{meta}</small> : null}
      </span>
    </button>;
  };
  return <section className="av-side__section" aria-label="넣을 곳">
    <SectionLabel title="넣을 곳" />
    <div className="av-dest" role="radiogroup" aria-label="넣을 곳" ref={group} onKeyDown={keyDown}>
      {rows.map(item => row(item.id,
        <span className="av-dest__thumb" aria-hidden="true">{item.thumbUrl && !privacy && <img src={item.thumbUrl} alt="" draggable={false} />}</span>,
        item.name, item.meta, item.warning))}
      {row(NEW_DESTINATION, <span className="av-dest__thumb av-dest__thumb--icon" aria-hidden="true"><PlusIcon /></span>, "새 컬렉션", null)}
      {value === NEW_DESTINATION && <div className="av-dest__name-field">
        <Field label="이름"><TextInput maxLength={4000} value={newName} disabled={disabled} onChange={event => onNewName(event.target.value)} /></Field>
      </div>}
    </div>
    <Button variant="quiet" className="av-dest__other" aria-expanded={otherOpen} disabled={disabled} onClick={onOther}><MagnifyingGlassIcon aria-hidden="true" />다른 컬렉션…</Button>
    {otherOpen && otherPanel}
  </section>;
}

export type PickItem = { id: string; primary: string; secondary?: string | null; thumbUrl?: string | null };

/** A search field over a short list, for choosing another collection or an existing person (inline on the PC, in a sheet on the tablet). */
export function AvPickList({ label, query, onQuery, items, onPick, empty = "검색 결과 없음", footer, privacy = false }: {
  label: string;
  query: string;
  onQuery(value: string): void;
  items: PickItem[];
  onPick(id: string): void;
  empty?: string;
  footer?: ReactNode;
  privacy?: boolean;
}) {
  return <div className="av-pick">
    <TextInput autoFocus aria-label={label} placeholder={label} maxLength={120} value={query} onChange={event => onQuery(event.target.value)} />
    <div className="av-pick__list" role="listbox" aria-label={`${label} 결과`}>
      {items.map(item => <button key={item.id} type="button" role="option" aria-selected={false} className="av-pick__item" onClick={() => onPick(item.id)}>
        {item.thumbUrl !== undefined && <span className="av-dest__thumb" aria-hidden="true">{item.thumbUrl && !privacy && <img src={item.thumbUrl} alt="" draggable={false} />}</span>}
        <span className="av-dest__text"><span className="av-dest__name">{item.primary}</span>{item.secondary && <small lang="ja">{item.secondary}</small>}</span>
      </button>)}
      {items.length === 0 && <p className="av-pick__empty">{empty}</p>}
    </div>
    {footer}
  </div>;
}
