import type { ReactNode } from "react";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { SettingsRow } from "../shared/ui/SettingsRow";
import { TextInput } from "../shared/ui/TextInput";

const SimpleRow = SettingsRow;

export function InlineEdit({ children }: { children: ReactNode }) { return <div className="settings-view__inline-edit">{children}</div>; }

export function ConfirmLine({ text, onCancel, onConfirm, busy, confirmLabel = "확인" }: { text: string; onCancel: () => void; onConfirm: () => void; busy: boolean; confirmLabel?: string }) {
  return <div className="settings-view__confirm-line"><span>{text}</span><span className="settings-view__control-pair"><Button size="sm" variant="quiet" disabled={busy} onClick={onCancel}>취소</Button><Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button></span></div>;
}

export function CredentialRow({ name, placeholder, help, configured, editing, value, secondValue, busy, onEdit, onChange, onSecondChange, onSave, onCancel, confirmDelete, onDelete, onCancelDelete, onConfirmDelete }: { name: string; placeholder?: string; help?: string; configured: boolean | null; editing: boolean; value: string; secondValue?: string; busy: boolean; onEdit: () => void; onChange: (value: string) => void; onSecondChange?: (value: string) => void; onSave: () => void; onCancel: () => void; confirmDelete: boolean; onDelete: () => void; onCancelDelete: () => void; onConfirmDelete: () => void }) {
  return <>
    <SimpleRow name={name} control={!editing ? <span className="settings-view__control-pair"><Badge>{configured ? "설정됨" : "없음"}</Badge><Button size="sm" variant="quiet" aria-label={`${name} ${configured ? "바꾸기" : "입력"}`} onClick={onEdit}>{configured ? "바꾸기" : "입력"}</Button>{configured && <Button size="sm" variant="quiet" aria-label={`${name} 삭제`} className="settings-view__danger-action" onClick={onDelete}>삭제</Button>}</span> : undefined} />
    {help && <p className="settings-view__status">{help}</p>}
    {editing && <InlineEdit><TextInput aria-label={`${name} 입력`} placeholder={placeholder} type="password" autoComplete="off" value={value} onChange={event => onChange(event.target.value)} />{secondValue !== undefined && onSecondChange && <TextInput aria-label={`${name} Secret`} type="password" autoComplete="off" value={secondValue} onChange={event => onSecondChange(event.target.value)} />}<Button size="sm" variant="quiet" disabled={busy || !value.trim() || (secondValue !== undefined && !secondValue.trim())} onClick={onSave}>저장</Button><Button size="sm" variant="quiet" onClick={onCancel}>취소</Button></InlineEdit>}
    {confirmDelete && <ConfirmLine text={`${name} 설정을 삭제할까요?`} onCancel={onCancelDelete} onConfirm={onConfirmDelete} busy={busy} confirmLabel="삭제 확인" />}
  </>;
}
