const tvGenres: Record<string, string> = {
  "Action & Adventure": "액션 & 모험",
  "Sci-Fi & Fantasy": "SF & 판타지",
  "War & Politics": "전쟁 & 정치",
  Kids: "키즈",
  News: "뉴스",
  Reality: "리얼리티",
  Soap: "연속극",
  Talk: "토크",
};

export function displayGenres(value: string | null | undefined): string {
  // Stored genre lists use commas or middle dots. Preserve their separators.
  return (value ?? "").split(/(\s*[,·]\s*)/).map(genre => Object.prototype.hasOwnProperty.call(tvGenres, genre) ? tvGenres[genre] : genre).join("");
}
