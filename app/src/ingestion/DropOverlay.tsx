export function DropOverlay({ over, destinationName }: { over: { x: number; y: number } | null; destinationName: string }) {
  if (!over) return null;
  return <div className="drop-overlay" role="status" aria-live="polite">
    <strong>{destinationName}에 저장</strong>
    <span>JPEG · PNG · GIF · WebP</span>
  </div>;
}
