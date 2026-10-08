import { displayDate } from "../../shared/displayDate";

/** The same quiet library line on the PC and tablet performer profiles. */
export function AvPerformerLibraryStats({ workCount, soloCount, firstRelease, lastRelease, averageScore }: {
  workCount: number; soloCount: number; firstRelease: string | null; lastRelease: string | null; averageScore: number | null;
}) {
  const first = displayDate(firstRelease), last = displayDate(lastRelease);
  const range = first && last && first !== last ? `${first}–${last}` : first || last;
  return <p className="av-performer-library-stats numeric" aria-label="내 서재 통계">
    내 작품 {workCount.toLocaleString()}편 · 단독 {soloCount.toLocaleString()}{range && ` · 발매 ${range}`}{averageScore !== null && ` · 평균 ★${averageScore.toFixed(1)}`}
  </p>;
}
