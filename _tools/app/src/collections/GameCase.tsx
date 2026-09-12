import { PhysicalCover } from "./physical/PhysicalCover";

/** Approved SteelBook appearance, now rendered once and reused as a cached image. */
export function GameCase({ src, alt, onError, scope = "", revision = "", large = false }: {
  src: string; alt: string; onError?: () => void; scope?: string; revision?: string; large?: boolean;
}) {
  return <span className="game-case game-case--cached">
    <PhysicalCover kind="game" src={src} alt={alt} scope={scope} revision={revision} large={large} onError={onError} />
  </span>;
}
