export function DropOverlay({ over, destinationName }: { over: { x: number; y: number } | null; destinationName: string }) {
  if (!over) return null;
  return <div className="drop-overlay" role="status" aria-live="polite">
    <div className="drop-overlay__message">
      <strong>여기에 놓아 추가</strong>
      <span>{destinationName} · 이미지와 영상 파일</span>
    </div>
  </div>;
}
