/**
 * Korean display names for IGDB game genres.
 * Like `avGenreNames.ts`, this is a fixed table applied when a genre is shown: stored genres stay in English and
 * are never rewritten. A genre that is not in the table is shown as it was stored.
 */
const GAME_GENRES: Record<string, string> = {
  "Point-and-click": "포인트 앤 클릭",
  Fighting: "격투",
  Shooter: "슈팅",
  Music: "음악",
  Platform: "플랫포머",
  Puzzle: "퍼즐",
  Racing: "레이싱",
  "Real Time Strategy (RTS)": "실시간 전략",
  "Role-playing (RPG)": "RPG",
  Simulator: "시뮬레이션",
  Sport: "스포츠",
  Strategy: "전략",
  "Turn-based strategy (TBS)": "턴제 전략",
  Tactical: "택티컬",
  "Hack and slash/Beat 'em up": "핵 앤 슬래시/벨트스크롤",
  "Quiz/Trivia": "퀴즈",
  Pinball: "핀볼",
  Adventure: "어드벤처",
  Indie: "인디",
  Arcade: "아케이드",
  "Visual Novel": "비주얼 노벨",
  "Card & Board Game": "카드/보드 게임",
  MOBA: "MOBA",
};

/** One stored game genre in Korean, or as stored when the table does not know it. */
export function gameGenreName(genre: string): string {
  return Object.prototype.hasOwnProperty.call(GAME_GENRES, genre) ? GAME_GENRES[genre] : genre;
}

/** A stored genre list ("Role-playing (RPG) · Adventure") in Korean, keeping its separators. */
export function displayGameGenres(value: string | null | undefined): string {
  return (value ?? "").split(/(\s*[,·]\s*)/).map((part, index) => index % 2 ? part : gameGenreName(part)).join("");
}
