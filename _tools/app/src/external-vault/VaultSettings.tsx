import { open } from "@tauri-apps/plugin-dialog";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { EncryptedVaultSidecarCleanupPreview, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { vaultErrorMessage } from "./vaultErrors";
import { useVaultImportJob } from "./vaultImportJob";
import "./externalVault.css";

type Mode = "idle" | "create" | "password";

/** Settings > 데이터 관리 > 비밀 보관함 (ADR-0039). */
export function VaultSettings({ onChanged, onSaved }: { onChanged?: () => void | Promise<void>; onSaved?: (message: string) => void }) {
  const { gateway } = useLibrary();
  const [status, setStatus] = useState<EncryptedVaultStatus | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gateway.getEncryptedVaultStatus) return;
    let active = true;
    void gateway.getEncryptedVaultStatus()
      .then((next) => { if (active) setStatus(next); })
      .catch((cause: unknown) => { if (active) setError(commandErrorMessage(cause, "비밀 보관함 상태를 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [gateway]);

  async function run(action: () => Promise<EncryptedVaultStatus | void>, fallback: string, saved?: string, secretKind: "password" | "recoveryKey" = "password") {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
      if (saved) onSaved?.(saved);
      await onChanged?.();
      return true;
    } catch (cause) {
      setError(vaultErrorMessage(cause, secretKind, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!gateway.getEncryptedVaultStatus) return null;
  if (recoveryKey !== null) {
    return <RecoveryKeyStep recoveryKey={recoveryKey} onDone={() => { setRecoveryKey(null); setMode("idle"); void onChanged?.(); }} />;
  }
  const present = status !== null && status.state !== "absent";
  const unlocked = status?.state === "unlocked";
  return <dl className="settings-view__property">
    <dt>상태</dt>
    <dd className="settings-view__path">{present ? status.root : "연결된 보관함 없음"}</dd>
    <dd className="settings-view__row-note">
      {!present
        ? "USB 폴더에 암호화된 보관함을 만듭니다. 비밀번호를 잊으면 만들 때 받은 복구키로만 열 수 있습니다."
        : [unlocked ? `열림 · ${(status.itemCount ?? 0).toLocaleString()}개` : "잠김 · 비밀 화면에서 열 수 있습니다", status.remembered ? "이 PC에서 기억함" : null].filter(Boolean).join(" · ")}
    </dd>
    {mode === "idle" && <dd className="settings-view__actions">
      {!present && <Button size="sm" disabled={busy || !gateway.createEncryptedVault} onClick={() => { setError(null); setMode("create"); }}>새 보관함 만들기</Button>}
      {unlocked && <Button size="sm" disabled={busy || !gateway.changeEncryptedVaultPassword} onClick={() => { setError(null); setMode("password"); }}>비밀번호 변경</Button>}
      {present && status.remembered && <Button size="sm" disabled={busy || !gateway.forgetEncryptedVaultKey}
        onClick={() => void run(() => gateway.forgetEncryptedVaultKey!(), "기억한 키를 지우지 못했습니다.", "이 PC에서 기억한 키를 지웠습니다")}>이 PC에서 기억 해제</Button>}
      {unlocked && <Button size="sm" disabled={busy || !gateway.lockEncryptedVault}
        onClick={() => void run(() => gateway.lockEncryptedVault!(), "비밀 보관함을 잠그지 못했습니다.", "비밀 보관함을 잠갔습니다")}>잠그기</Button>}
    </dd>}
    {mode === "create" && <CreateForm busy={busy} onCancel={() => setMode("idle")} onError={setError}
      onCreate={async (root, password, remember) => {
        let key: string | null = null;
        const ok = await run(async () => {
          const created = await gateway.createEncryptedVault!(root, password, remember);
          key = created.recoveryKey;
          return created.status;
        }, "비밀 보관함을 만들지 못했습니다.");
        if (ok && key !== null) setRecoveryKey(key);
      }} />}
    {mode === "password" && <PasswordForm busy={busy} onCancel={() => setMode("idle")} onError={setError}
      onChange={async (current, next) => {
        const ok = await run(() => gateway.changeEncryptedVaultPassword!(current, next), "비밀번호를 바꾸지 못했습니다.", "비밀번호를 변경했습니다", current.kind);
        if (ok) setMode("idle");
      }} />}
    {error && <dd className="settings-view__row-message" role="alert">{error}</dd>}
    {unlocked && mode === "idle" && <SidecarCleanup gateway={gateway} vaultId={status.vaultId} onChanged={onChanged} onSaved={onSaved} />}
  </dl>;
}

/**
 * One-time cleanup of `<video>_thumb.jpg` images imported before the sidecar rule: shown only
 * while such images exist. Refused while a vault import runs (the backend checks too).
 */
function SidecarCleanup({ gateway, vaultId, onChanged, onSaved }: {
  gateway: LibraryGateway;
  vaultId: string | null;
  onChanged?: () => void | Promise<void>;
  onSaved?: (message: string) => void;
}) {
  const { job, completions } = useVaultImportJob();
  const importing = Boolean(job?.running);
  const [preview, setPreview] = useState<EncryptedVaultSidecarCleanupPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = gateway.previewEncryptedVaultSidecarCleanup;

  useEffect(() => {
    if (!load || importing) return;
    let active = true;
    void load()
      .then((next) => { if (active) setPreview(next); })
      .catch(() => { if (active) setPreview(null); });
    return () => { active = false; };
  }, [load, importing, completions, vaultId]);

  async function apply() {
    if (!gateway.applyEncryptedVaultSidecarCleanup) return;
    setBusy(true);
    setError(null);
    try {
      const done = await gateway.applyEncryptedVaultSidecarCleanup();
      const message = `썸네일 이미지 ${done.removed.toLocaleString()}개를 목록에서 뺐습니다`
        + (done.movedToVideoThumbnail > 0 ? ` · 영상 썸네일로 옮김 ${done.movedToVideoThumbnail.toLocaleString()}개` : "");
      setResult(message);
      onSaved?.(message);
      setConfirming(false);
      setPreview(await load!().catch(() => null));
      await onChanged?.();
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
      setError(code === "encrypted_vault_import_running"
        ? "가져오기가 끝난 뒤에 정리할 수 있습니다."
        : commandErrorMessage(cause, "썸네일 파일을 정리하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  const count = preview?.count ?? 0;
  if (count === 0 && result === null) return null;
  return <>
    <dt className="external-vault-cleanup__title">영상 썸네일 파일 정리</dt>
    {count > 0 && <dd className="settings-view__row-note">
      영상 옆에 있던 썸네일 이미지 {count.toLocaleString()}개를 해당 영상의 썸네일로 옮기고 목록에서 뺍니다.
      {importing && " 가져오기가 끝난 뒤에 정리할 수 있습니다."}
    </dd>}
    {count > 0 && !confirming && <dd className="settings-view__actions">
      <Button size="sm" disabled={busy || importing || !gateway.applyEncryptedVaultSidecarCleanup}
        onClick={() => { setError(null); setResult(null); setConfirming(true); }}>썸네일 파일 정리</Button>
    </dd>}
    {count > 0 && confirming && <dd className="external-vault-form-row external-vault-cleanup" role="group" aria-label="썸네일 파일 정리 확인">
      <p>다음 이미지{count > preview!.examples.length ? ` 등 ${count.toLocaleString()}개` : ""}를 정리합니다. 영상에 이미 썸네일이 있으면 그 썸네일을 유지합니다.</p>
      <ul className="external-vault-cleanup__examples">
        {preview!.examples.map((name) => <li key={name}>{name}</li>)}
      </ul>
      <div className="external-vault-actions">
        <Button size="sm" variant="primary" disabled={busy || importing} onClick={() => void apply()}>{busy ? "정리하는 중…" : "정리하기"}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>취소</Button>
      </div>
    </dd>}
    {result && <dd className="settings-view__row-message" role="status">{result}</dd>}
    {error && <dd className="settings-view__row-message" role="alert">{error}</dd>}
  </>;
}

function CreateForm({ busy, onCancel, onError, onCreate }: { busy: boolean; onCancel(): void; onError(message: string | null): void; onCreate(root: string, password: string, remember: boolean): Promise<void> }) {
  const [root, setRoot] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  async function chooseFolder() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "비밀 보관함을 만들 USB 폴더" });
      if (typeof selected === "string") setRoot(selected);
    } catch (cause) {
      onError(commandErrorMessage(cause, "폴더를 선택하지 못했습니다."));
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!root) return onError("보관함을 만들 폴더를 선택하세요.");
    if (!password) return onError("비밀번호를 입력하세요.");
    if (password !== confirm) return onError("비밀번호가 서로 다릅니다.");
    onError(null);
    void onCreate(root, password, remember);
  }
  return <dd className="external-vault-form-row">
    <form className="external-vault-form" onSubmit={submit}>
      <div className="external-vault-form__folder">
        <span className="settings-view__path">{root ?? "폴더를 선택하지 않았습니다"}</span>
        <Button type="button" size="sm" disabled={busy} onClick={() => void chooseFolder()}>보관할 폴더 선택</Button>
      </div>
      <TextField type="password" label="비밀번호" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      <TextField type="password" label="비밀번호 확인" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      <label className="external-vault-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />이 PC에서 기억</label>
      <div className="external-vault-actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>{busy ? "만드는 중…" : "만들기"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>취소</Button>
      </div>
    </form>
  </dd>;
}

function PasswordForm({ busy, onCancel, onError, onChange }: { busy: boolean; onCancel(): void; onError(message: string | null): void; onChange(current: { kind: "password" | "recoveryKey"; value: string }, next: string): Promise<void> }) {
  const [kind, setKind] = useState<"password" | "recoveryKey">("password");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!current) return onError(kind === "password" ? "현재 비밀번호를 입력하세요." : "복구키를 입력하세요.");
    if (!next) return onError("새 비밀번호를 입력하세요.");
    if (next !== confirm) return onError("새 비밀번호가 서로 다릅니다.");
    onError(null);
    void onChange({ kind, value: kind === "recoveryKey" ? current.trim() : current }, next);
  }
  return <dd className="external-vault-form-row">
    <form className="external-vault-form" onSubmit={submit}>
      <TextField key={kind} type={kind === "password" ? "password" : "text"} label={kind === "password" ? "현재 비밀번호" : "복구키"}
        autoComplete="off" spellCheck={false} value={current} onChange={(event) => setCurrent(event.target.value)} />
      <TextField type="password" label="새 비밀번호" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
      <TextField type="password" label="새 비밀번호 확인" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      <div className="external-vault-actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>변경</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setKind(kind === "password" ? "recoveryKey" : "password"); setCurrent(""); }}>
          {kind === "password" ? "복구키로 확인" : "현재 비밀번호로 확인"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>취소</Button>
      </div>
    </form>
  </dd>;
}

/** Shown once after creation; like notes key setup, continuing requires an explicit confirmation. */
function RecoveryKeyStep({ recoveryKey, onDone }: { recoveryKey: string; onDone(): void }) {
  const [qr, setQr] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(recoveryKey, { margin: 2, width: 220, errorCorrectionLevel: "M" })
      .then((url) => { if (active) setQr(url); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [recoveryKey]);
  return <div className="external-vault-recovery" role="group" aria-label="비밀 보관함 복구키">
    <strong>복구키</strong>
    <p>비밀번호를 잊었을 때 보관함을 여는 유일한 방법입니다. 지금 한 번만 표시됩니다.</p>
    {qr && <img className="external-vault-recovery__qr" src={qr} alt="복구키 QR 코드" width={220} height={220} />}
    <textarea className="ui-input external-vault-recovery__key" aria-label="복구키" value={recoveryKey} readOnly spellCheck={false} autoComplete="off" />
    <label className="external-vault-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />복구키를 안전한 곳에 보관했습니다</label>
    <div className="external-vault-actions"><Button size="sm" variant="primary" disabled={!confirmed} onClick={onDone}>계속</Button></div>
  </div>;
}
