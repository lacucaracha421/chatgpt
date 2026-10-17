import { BookOpenIcon, FilmIcon, PuzzlePieceIcon, TvIcon } from "@heroicons/react/24/outline";
import type { ReleaseKind } from "./homeModel";

/** One 16px glyph per release kind; the manga one is the app's 망가 area icon. The kind word stays as the accessible name. */
const KINDS = {
  game: { name: "게임", Icon: PuzzlePieceIcon },
  movie: { name: "영화", Icon: FilmIcon },
  anime: { name: "애니", Icon: TvIcon },
  manga: { name: "만화", Icon: BookOpenIcon },
} as const satisfies Record<ReleaseKind, { name: string; Icon: typeof FilmIcon }>;

export const releaseKindName = (kind: ReleaseKind) => KINDS[kind].name;

export function ReleaseKindMark({ kind }: { kind: ReleaseKind }) {
  const { name, Icon } = KINDS[kind];
  return <span className="home-kind" role="img" aria-label={name}><Icon aria-hidden="true" /></span>;
}

/** The volume of a manga release (`22권`); the other details were only the kind word, which the icon now carries. */
export const volumeDetail = (detail: string) => /권$/.test(detail) ? detail : "";
