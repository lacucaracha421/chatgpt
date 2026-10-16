import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { formatBytes } from "../shared/formatBytes";
import { displayDateTime } from "../shared/displayDate";
import { Badge } from "../shared/ui/Badge";
import { CLUE_ROWS, EMPTY_CLUES, ROLE_LABELS, type ClueKey, type Clues, type ClueSideData, type ClueSideKey } from "./clues";

type Props = {
  names: [string, string]; sides: [ClueSideData, ClueSideData]; clues?: Clues | null;
  reason?: ClueKey | null; recommended?: ClueSideKey | null;
};
export function SimilarityClues({ names, sides, clues, reason, recommended }: Props) {
  const evidence = clues ?? EMPTY_CLUES;
  const favoured = recommended ?? (reason ? evidence[reason] : null);
  const now = new Date();
  function value(side: ClueSideData, key: ClueKey) {
    const missing = <span className="clue-none">—</span>;
    switch (key) {
      case "account": return <>{side.handle ? <span className="clue-handle">{side.handle}</span> : <span className="clue-host">{side.host ?? "—"}</span>}<Badge>{ROLE_LABELS[side.role]}</Badge></>;
      case "posted": return side.postedAt && Number.isFinite(new Date(side.postedAt).getTime()) ? <span className="numeric">{displayDateTime(side.postedAt, now, { withTime: true })}</span> : missing;
      case "resolution": return side.width && side.height ? <span className="numeric">{side.width.toLocaleString()} × {side.height.toLocaleString()}</span> : missing;
      case "bytes": return <>{side.byteSize == null ? missing : <span className="numeric">{formatBytes(side.byteSize)}</span>}<span className="clue-format">{side.format}</span></>;
    }
  }
  return <table className="similarity-clues">
    <caption className="clue-sr">단서 비교</caption>
    <thead><tr><th scope="col" className="clue-side clue-side--a">{names[0]}{favoured === "a" && <Badge>권장</Badge>}</th><th aria-hidden="true"/><th scope="col" className="clue-side clue-side--b">{names[1]}{favoured === "b" && <Badge>권장</Badge>}</th></tr></thead>
    <tbody>{CLUE_ROWS.map(([key,label]) => <tr key={key} data-deciding={clues && reason === key || undefined}>
      <td className="clue-value clue-value--a" data-favoured={evidence[key] === "a" || undefined} data-other={evidence[key] === "b" || undefined}>{value(sides[0],key)}</td>
      <th scope="row" className="clue-label"><span className="clue-mark">{evidence[key] === "a" && <ChevronLeftIcon className="chev" aria-hidden="true"/>}</span><span>{label}{evidence[key] && <span className="clue-sr"> · {names[evidence[key] === "a" ? 0 : 1]} 쪽</span>}</span><span className="clue-mark">{evidence[key] === "b" && <ChevronRightIcon className="chev" aria-hidden="true"/>}</span></th>
      <td className="clue-value clue-value--b" data-favoured={evidence[key] === "b" || undefined} data-other={evidence[key] === "a" || undefined}>{value(sides[1],key)}</td>
    </tr>)}</tbody>
  </table>;
}
