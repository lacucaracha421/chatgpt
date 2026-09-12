import { useEffect, useMemo, useState } from "react";
import { QR_VIEWBOX_SIZE, createQrMatrix, qrSvgPath } from "../shared/ui/qrCode";
import { Button } from "../shared/ui/Button";

export type ExtensionPairingQrValue = { pairingUrl: string; expiresAt: string };

type ExtensionPairingQrProps = {
  value: ExtensionPairingQrValue;
  onCopy: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
};

function remainingSeconds(expiresAt: string, now: number): number {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 1000)) : 0;
}

function timerLabel(seconds: number): string {
  if (seconds <= 0) return "만료";
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ExtensionPairingQr({ value, onCopy, onRefresh, onClose }: ExtensionPairingQrProps) {
  const [now, setNow] = useState(() => Date.now());
  const seconds = remainingSeconds(value.expiresAt, now);
  const path = useMemo(() => qrSvgPath(createQrMatrix(value.pairingUrl)), [value.pairingUrl]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [value.expiresAt]);

  return (
    <section className="extension-pairing" aria-label="확장 연결 QR">
      <header className="extension-pairing__header">
        <strong>확장 연결</strong>
        <span className={seconds > 0 ? "extension-pairing__timer" : "extension-pairing__timer extension-pairing__timer--expired"}>{timerLabel(seconds)}</span>
        <button className="extension-pairing__close" aria-label="닫기" onClick={onClose}>×</button>
      </header>
      <div className="extension-pairing__qr" aria-label="갤럭시 탭에서 스캔할 연결 QR">
        <svg role="img" aria-label="Lakomics 확장 연결 QR 코드" viewBox={`0 0 ${QR_VIEWBOX_SIZE} ${QR_VIEWBOX_SIZE}`} shapeRendering="crispEdges">
          <rect width={QR_VIEWBOX_SIZE} height={QR_VIEWBOX_SIZE} fill="#f2f0e8" />
          <path d={path} fill="#171816" />
        </svg>
      </div>
      <div className="extension-pairing__actions">
        <Button size="sm" disabled={seconds <= 0} onClick={() => void onCopy()}>링크 복사</Button>
        <Button size="sm" onClick={() => void onRefresh()}>새로 발급</Button>
      </div>
    </section>
  );
}

export const extensionPairingQrTestApi = { remainingSeconds, timerLabel };
