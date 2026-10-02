import dictionaryData from "./dictionaryData.json";

/**
 * Korean labels and display groups for frequent Danbooru tags (자동 태그).
 *
 * Covers the ~600 most frequent general tags in the library (PixAI tagger v0.9 output,
 * 2026-09-27). Tags outside the dictionary show their Danbooru name with `_` → space and fall
 * into 기타. Character tags are never listed here: they show their prettified name.
 * `meta` entries (watermarks, user names, logos) are not displayed.
 */

export type AutoTagDisplayGroup = "body" | "wear" | "pose" | "sex" | "scene" | "etc";

const BODY: Record<string, string> = dictionaryData.groups.body;

const WEAR: Record<string, string> = dictionaryData.groups.wear;

const POSE: Record<string, string> = dictionaryData.groups.pose;

const SEX: Record<string, string> = dictionaryData.groups.sex;

const SCENE: Record<string, string> = dictionaryData.groups.scene;

const ETC: Record<string, string> = dictionaryData.groups.etc;

/** Present in the tagger output but not shown: they describe the file, not the picture. */
export const HIDDEN_TAGS: ReadonlySet<string> = new Set(dictionaryData.hidden);

/** Frequent, low-information tags: listed last in their group and dimmed. */
export const COMMON_TAGS: ReadonlySet<string> = new Set([
  "1girl", "1boy", "1other", "solo", "solo_focus", "looking_at_viewer", "simple_background", "white_background", "grey_background",
  "gradient_background", "upper_body", "cowboy_shot", "full_body", "portrait", "blush", "smile", "closed_mouth", "open_mouth",
  "parted_lips", "standing", "long_hair", "breasts", "short_hair", "holding", "teeth", "border",
]);

export const AUTO_TAG_DICTIONARY: ReadonlyMap<string, { ko: string; group: AutoTagDisplayGroup }> = new Map(
  ([["body", BODY], ["wear", WEAR], ["pose", POSE], ["sex", SEX], ["scene", SCENE], ["etc", ETC]] as const)
    .flatMap(([group, labels]) => Object.entries(labels).map(([tag, ko]) => [tag, { ko, group }] as const)),
);

/** Korean names for series qualifiers of character tags, e.g. `vertin_(reverse:1999)`. */
export const SERIES_LABELS: Readonly<Record<string, string>> = {
  blue_archive: "블루 아카이브", zenless_zone_zero: "젠레스 존 제로", wuthering_waves: "명조", "reverse:1999": "리버스:1999",
  chainsaw_man: "체인소 맨", girls_band_cry: "걸즈 밴드 크라이", nikke: "니케", "goddess_of_victory:_nikke": "니케",
  genshin_impact: "원신", "honkai:_star_rail": "붕괴: 스타레일", honkai_impact: "붕괴3rd", honkai_impact_3rd: "붕괴3rd",
  hololive: "홀로라이브", vocaloid: "보컬로이드", gakuen_idolmaster: "학원 아이돌마스터", idolmaster: "아이돌마스터",
  gundam_suisei_no_majo: "건담 수성의 마녀", ghost_in_the_shell: "공각기동대", metroid: "메트로이드", project_moon: "프로젝트 문",
  limbus_company: "림버스 컴퍼니", alien_stage: "에일리언 스테이지", pokemon: "포켓몬", arknights: "명일방주", azur_lane: "벽람항로",
  "girls'_frontline": "소녀전선", umamusume: "우마무스메", touhou: "동방", kancolle: "칸코레", project_sekai: "프로젝트 세카이",
  "love_live!": "러브 라이브!", jujutsu_kaisen: "주술회전", "bang_dream!": "뱅드림!", sousou_no_frieren: "장송의 프리렌",
  "bocchi_the_rock!": "봇치 더 록!", oshi_no_ko: "최애의 아이", "fate_(series)": "페이트", fate: "페이트",
};

/** Series of frequent character tags whose name has no series qualifier. */
export const CHARACTER_SERIES: Readonly<Record<string, string>> = {
  ellen_joe: "zenless_zone_zero", hoshimi_miyabi: "zenless_zone_zero", nicole_demara: "zenless_zone_zero",
  hatsune_miku: "vocaloid", shinosawa_hiro: "gakuen_idolmaster", fujita_kotone: "gakuen_idolmaster",
  suletta_mercury: "gundam_suisei_no_majo", miorine_rembran: "gundam_suisei_no_majo", houshou_marine: "hololive",
  tokoyami_towa: "hololive", shirogane_noel: "hololive", oozora_subaru: "hololive", hoshimachi_suisei: "hololive",
  kobo_kanaeru: "hololive", raora_panthera: "hololive", iseri_nina: "girls_band_cry", kawaragi_momoka: "girls_band_cry",
  awa_subaru: "girls_band_cry", ebizuka_tomo: "girls_band_cry", kusanagi_motoko: "ghost_in_the_shell", samus_aran: "metroid",
  kiana_kaslana: "honkai_impact_3rd",
};
