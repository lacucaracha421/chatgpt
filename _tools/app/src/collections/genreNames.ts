/**
 * Korean display names for MangaDex tags. MangaDex publishes tag names in English only, so
 * imported manga genres are stored as English text ("Action, Romance, Isekai"). The names
 * are translated when shown; the stored genres are never rewritten.
 *
 * Covers the official MangaDex tag list (format, genre, theme and content groups) plus a
 * few retired tags that older imports may still carry.
 */
const MANGADEX_TAGS: Record<string, string> = {
  // Format
  "4-Koma": "4컷",
  Adaptation: "원작 있음",
  Anthology: "앤솔러지",
  "Award Winning": "수상작",
  Doujinshi: "동인지",
  "Fan Colored": "팬 컬러",
  "Full Color": "풀컬러",
  "Long Strip": "세로 스크롤",
  "Official Colored": "공식 컬러",
  Oneshot: "단편",
  "Self-Published": "자가 출판",
  "Web Comic": "웹코믹",
  // Genre
  Action: "액션",
  Adventure: "모험",
  "Boys' Love": "BL",
  Comedy: "코미디",
  Crime: "범죄",
  Drama: "드라마",
  Fantasy: "판타지",
  "Girls' Love": "백합",
  Historical: "시대극",
  Horror: "호러",
  Isekai: "이세계",
  "Magical Girls": "마법소녀",
  Mecha: "메카",
  Medical: "의료",
  Mystery: "미스터리",
  Philosophical: "철학",
  Psychological: "심리",
  Romance: "로맨스",
  "Sci-Fi": "SF",
  "Slice of Life": "일상",
  Sports: "스포츠",
  Superhero: "슈퍼히어로",
  Thriller: "스릴러",
  Tragedy: "비극",
  Wuxia: "무협",
  // Theme
  Aliens: "외계인",
  Animals: "동물",
  Cooking: "요리",
  Crossdressing: "여장·남장",
  Delinquents: "불량아",
  Demons: "악마",
  Genderswap: "성전환",
  Ghosts: "유령",
  Gyaru: "갸루",
  Harem: "하렘",
  Incest: "근친",
  Loli: "로리",
  Mafia: "마피아",
  Magic: "마법",
  "Martial Arts": "무술",
  Military: "밀리터리",
  "Monster Girls": "몬스터 걸",
  Monsters: "몬스터",
  Music: "음악",
  Ninja: "닌자",
  "Office Workers": "직장인",
  Police: "경찰",
  "Post-Apocalyptic": "포스트 아포칼립스",
  Reincarnation: "환생",
  "Reverse Harem": "역하렘",
  Samurai: "사무라이",
  "School Life": "학원",
  Shota: "쇼타",
  Supernatural: "초자연",
  Survival: "서바이벌",
  "Time Travel": "타임리프",
  "Traditional Games": "전통 게임",
  Vampires: "뱀파이어",
  "Video Games": "게임",
  Villainess: "악역 영애",
  "Virtual Reality": "가상현실",
  Zombies: "좀비",
  // Content
  Gore: "고어",
  "Sexual Violence": "성폭력",
  // Retired tags still found in older imports
  Ecchi: "에치",
  "Shoujo Ai": "백합",
  "Shounen Ai": "BL",
};

/** Case, curly apostrophes and repeated spaces do not change a tag. */
const tagKey = (name: string) => name.trim().replace(/[‘’`]/g, "'").replace(/\s+/g, " ").toLowerCase();
const KOREAN = new Map(Object.entries(MANGADEX_TAGS).map(([english, korean]) => [tagKey(english), korean]));

/** The Korean name of one MangaDex tag; an unknown or already-Korean name is returned trimmed. */
export function koreanGenreName(name: string): string {
  return KOREAN.get(tagKey(name)) ?? name.trim();
}

/** A stored manga genre list (comma or middle-dot separated) as Korean names, without duplicates. */
export function koreanGenres(value: string | null | undefined): string[] {
  const names = (value ?? "").split(/[,·]/).map(name => name.trim()).filter(Boolean).map(koreanGenreName);
  return [...new Set(names)];
}

/** The same list as one line for text displays. */
export function koreanGenreText(value: string | null | undefined): string {
  return koreanGenres(value).join(", ");
}
