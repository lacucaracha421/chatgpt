/**
 * Korean labels and display groups for frequent Danbooru tags (자동 태그).
 *
 * Covers the ~600 most frequent general tags in the library (PixAI tagger v0.9 output,
 * 2026-09-27). Tags outside the dictionary show their Danbooru name with `_` → space and fall
 * into 기타. Character tags are never listed here: they show their prettified name.
 * `meta` entries (watermarks, user names, logos) are not displayed.
 */

export type AutoTagDisplayGroup = "body" | "wear" | "pose" | "sex" | "scene" | "etc";

const BODY: Record<string, string> = {
  "1girl": "여자 1명", "2girls": "여자 2명", "3girls": "여자 3명", "4girls": "여자 4명", "5girls": "여자 5명", "6+girls": "여자 6명 이상",
  "1boy": "남자 1명", "2boys": "남자 2명", "1other": "기타 1명", multiple_girls: "여러 여자", multiple_boys: "여러 남자", solo: "단독",
  solo_focus: "한 명 중심", male_focus: "남성 중심", genderswap: "성별 반전", "genderswap_(mtf)": "성별 반전 (남→여)", cat_girl: "고양이 소녀",
  gyaru: "갸루", dark_skin: "어두운 피부", "dark-skinned_female": "갈색 피부 여성", "dark-skinned_male": "갈색 피부 남성",
  long_hair: "긴 머리", very_long_hair: "아주 긴 머리", medium_hair: "중간 길이 머리", short_hair: "짧은 머리",
  black_hair: "검은 머리", blonde_hair: "금발", brown_hair: "갈색 머리", light_brown_hair: "밝은 갈색 머리", grey_hair: "회색 머리",
  white_hair: "흰 머리", pink_hair: "분홍 머리", blue_hair: "파란 머리", red_hair: "빨간 머리", purple_hair: "보라 머리",
  green_hair: "초록 머리", orange_hair: "주황 머리", aqua_hair: "청록 머리", multicolored_hair: "여러 색 머리", "two-tone_hair": "투톤 머리",
  streaked_hair: "브릿지 머리", colored_inner_hair: "안쪽 염색", gradient_hair: "그라데이션 머리",
  hair_between_eyes: "눈 사이 앞머리", blunt_bangs: "일자 앞머리", parted_bangs: "가르마 앞머리", crossed_bangs: "교차 앞머리",
  asymmetrical_bangs: "비대칭 앞머리", hair_intakes: "뻗친 앞머리", sidelocks: "옆머리", hair_over_one_eye: "한쪽 눈 가린 머리",
  one_eye_covered: "한쪽 눈 가림", hair_over_shoulder: "어깨에 걸친 머리", floating_hair: "날리는 머리", ahoge: "바보털",
  braid: "땋은 머리", single_braid: "한 갈래 땋은 머리", twin_braids: "양 갈래 땋은 머리", braided_ponytail: "땋은 포니테일",
  twintails: "트윈테일", low_twintails: "낮은 트윈테일", short_twintails: "짧은 트윈테일", ponytail: "포니테일",
  low_ponytail: "낮은 포니테일", side_ponytail: "사이드 포니테일", hair_bun: "번 머리", single_hair_bun: "번 하나",
  double_bun: "양쪽 번", single_side_bun: "한쪽 번", two_side_up: "투사이드업", one_side_up: "원사이드업", hair_rings: "고리 머리",
  drill_hair: "드릴 머리", curly_hair: "곱슬머리", wavy_hair: "웨이브 머리",
  blue_eyes: "파란 눈", red_eyes: "빨간 눈", green_eyes: "초록 눈", yellow_eyes: "노란 눈", purple_eyes: "보라 눈", brown_eyes: "갈색 눈",
  grey_eyes: "회색 눈", pink_eyes: "분홍 눈", black_eyes: "검은 눈", orange_eyes: "주황 눈", heterochromia: "오드아이",
  "symbol-shaped_pupils": "기호 모양 눈동자", eyelashes: "속눈썹", thick_eyebrows: "짙은 눈썹", "v-shaped_eyebrows": "V자 눈썹",
  animal_ears: "동물 귀", cat_ears: "고양이 귀", fox_ears: "여우 귀", rabbit_ears: "토끼 귀", animal_ear_fluff: "귀털",
  pointy_ears: "뾰족한 귀", horns: "뿔", demon_horns: "악마 뿔", halo: "헤일로", blue_halo: "파란 헤일로", red_halo: "빨간 헤일로",
  tail: "꼬리", cat_tail: "고양이 꼬리", wings: "날개", teeth: "이", upper_teeth_only: "윗니만", fang: "송곳니", fangs: "송곳니들",
  sharp_teeth: "뾰족한 이", tongue: "혀", mole: "점", mole_under_eye: "눈 밑 점", mole_under_mouth: "입가 점", mole_on_breast: "가슴 점",
  freckles: "주근깨", facial_mark: "얼굴 표식", forehead_mark: "이마 표식", scar: "흉터", tattoo: "문신", makeup: "화장",
  fingernails: "손톱", toenails: "발톱", breasts: "가슴", small_breasts: "작은 가슴", medium_breasts: "보통 가슴",
  large_breasts: "큰 가슴", huge_breasts: "아주 큰 가슴", collarbone: "쇄골", bare_shoulders: "드러난 어깨", armpits: "겨드랑이",
  navel: "배꼽", covered_navel: "옷 위 배꼽", stomach: "배", midriff: "드러난 배", back: "등", thighs: "허벅지", thick_thighs: "굵은 허벅지", legs: "다리",
  bare_legs: "맨다리", bare_arms: "맨팔", feet: "발", toes: "발가락", soles: "발바닥", barefoot: "맨발",
};

const WEAR: Record<string, string> = {
  shirt: "셔츠", white_shirt: "흰 셔츠", black_shirt: "검은 셔츠", blue_shirt: "파란 셔츠", collared_shirt: "칼라 셔츠",
  sleeveless_shirt: "민소매 셔츠", shirt_tucked_in: "셔츠 넣어 입음", long_sleeves: "긴 소매", short_sleeves: "반소매",
  puffy_sleeves: "퍼프 소매", puffy_long_sleeves: "퍼프 긴 소매", puffy_short_sleeves: "퍼프 반소매", wide_sleeves: "넓은 소매",
  juliet_sleeves: "줄리엣 소매", detached_sleeves: "분리 소매", sleeves_past_wrists: "손 덮는 소매", sleeves_rolled_up: "걷은 소매",
  sleeveless: "민소매", off_shoulder: "오프숄더", strapless: "끈 없는 옷", halterneck: "홀터넥", turtleneck: "터틀넥",
  crop_top: "크롭 톱", tank_top: "탱크톱", camisole: "캐미솔", sweater: "스웨터", cardigan: "카디건", hoodie: "후드티", vest: "조끼",
  black_vest: "검은 조끼", jacket: "재킷", open_jacket: "열린 재킷", black_jacket: "검은 재킷", white_jacket: "흰 재킷",
  blue_jacket: "파란 재킷", green_jacket: "초록 재킷", red_jacket: "빨간 재킷", cropped_jacket: "짧은 재킷", coat: "코트",
  open_coat: "열린 코트", black_coat: "검은 코트", white_coat: "흰 코트", blue_coat: "파란 코트", brown_coat: "갈색 코트",
  coat_on_shoulders: "어깨에 걸친 코트", cape: "망토", cloak: "클록", capelet: "케이플릿", open_clothes: "풀어헤친 옷",
  clothing_cutout: "컷아웃 옷", cleavage_cutout: "가슴 트임", torn_clothes: "찢어진 옷", striped_clothes: "줄무늬 옷",
  plaid_clothes: "체크무늬 옷", floral_print: "꽃무늬", denim: "데님", fur_trim: "퍼 장식", frills: "프릴",
  dress: "드레스", white_dress: "흰 드레스", black_dress: "검은 드레스", blue_dress: "파란 드레스", red_dress: "빨간 드레스",
  green_dress: "초록 드레스", purple_dress: "보라 드레스", long_dress: "긴 드레스", sleeveless_dress: "민소매 드레스",
  strapless_dress: "끈 없는 드레스", frilled_dress: "프릴 드레스", skirt: "치마", black_skirt: "검은 치마", white_skirt: "흰 치마",
  blue_skirt: "파란 치마", grey_skirt: "회색 치마", pleated_skirt: "주름 치마", plaid_skirt: "체크 치마", miniskirt: "미니스커트",
  long_skirt: "긴 치마", pants: "바지", black_pants: "검은 바지", white_pants: "흰 바지", blue_pants: "파란 바지", shorts: "반바지",
  short_shorts: "짧은 반바지", black_shorts: "검은 반바지", blue_shorts: "파란 반바지", denim_shorts: "데님 반바지",
  school_uniform: "교복", serafuku: "세일러복", sailor_collar: "세일러 칼라", neckerchief: "넥커치프", maid: "메이드",
  maid_headdress: "메이드 머리장식", maid_apron: "메이드 앞치마", apron: "앞치마", white_apron: "흰 앞치마", frilled_apron: "프릴 앞치마",
  japanese_clothes: "일본 옷", kimono: "기모노", chinese_clothes: "중국 옷", "greco-roman_clothes": "그리스·로마 옷",
  ancient_greek_clothes: "고대 그리스 옷", ouji_fashion: "왕자풍 옷", playboy_bunny: "바니걸", official_alternate_costume: "공식 다른 의상",
  alternate_costume: "다른 의상", armor: "갑옷", bodysuit: "바디슈트", leotard: "레오타드", black_leotard: "검은 레오타드",
  highleg: "하이레그", highleg_leotard: "하이레그 레오타드", strapless_leotard: "끈 없는 레오타드", pelvic_curtain: "앞자락 천",
  swimsuit: "수영복", "one-piece_swimsuit": "원피스 수영복", bikini: "비키니", white_bikini: "흰 비키니", black_bikini: "검은 비키니",
  string_bikini: "끈 비키니", micro_bikini: "마이크로 비키니", "side-tie_bikini_bottom": "옆끈 비키니 하의", underwear: "속옷",
  bra: "브래지어", panties: "팬티", black_panties: "검은 팬티",
  thighhighs: "사이하이", black_thighhighs: "검은 사이하이", white_thighhighs: "흰 사이하이", single_thighhigh: "한쪽 사이하이",
  pantyhose: "팬티스타킹", black_pantyhose: "검은 팬티스타킹", white_pantyhose: "흰 팬티스타킹", asymmetrical_legwear: "짝짝이 양말",
  socks: "양말", white_socks: "흰 양말", black_socks: "검은 양말", kneehighs: "니삭스", loose_socks: "루즈삭스", leg_warmers: "레그 워머",
  fishnets: "망사", thigh_strap: "허벅지 끈", footwear: "신발", shoes: "신발", black_footwear: "검은 신발", white_footwear: "흰 신발",
  brown_footwear: "갈색 신발", boots: "부츠", knee_boots: "무릎 부츠", thigh_boots: "사이하이 부츠", high_heel_boots: "하이힐 부츠",
  high_heels: "하이힐", sneakers: "운동화", sandals: "샌들", loafers: "로퍼", no_shoes: "신발 없음",
  gloves: "장갑", black_gloves: "검은 장갑", white_gloves: "흰 장갑", brown_gloves: "갈색 장갑", elbow_gloves: "긴 장갑",
  fingerless_gloves: "손가락 없는 장갑", wrist_cuffs: "손목 커프스", hat: "모자", black_hat: "검은 모자", white_hat: "흰 모자",
  green_hat: "초록 모자", black_headwear: "검은 모자", white_headwear: "흰 모자", beret: "베레모", boater_hat: "보터 모자",
  cabbie_hat: "캐스케트", top_hat: "실크햇", helmet: "헬멧", hood: "후드", hood_down: "내린 후드", headscarf: "머릿수건", veil: "베일",
  white_veil: "흰 베일", hat_bow: "모자 리본", hat_flower: "모자 꽃", hat_feather: "모자 깃털",
  hair_ornament: "머리 장식", hairclip: "머리핀", x_hair_ornament: "X자 머리 장식", hairband: "머리띠", black_hairband: "검은 머리띠",
  white_hairband: "흰 머리띠", checkered_hairband: "체크 머리띠", hair_bow: "머리 리본", hair_ribbon: "머리 리본", hair_flower: "머리 꽃",
  scrunchie: "곱창 밴드", fake_animal_ears: "가짜 동물 귀", bow: "리본", bowtie: "나비넥타이", ribbon: "리본", neck_ribbon: "목 리본",
  red_bow: "빨간 리본", blue_bow: "파란 리본", white_bow: "흰 리본", black_bow: "검은 리본", red_ribbon: "빨간 리본",
  blue_ribbon: "파란 리본", black_ribbon: "검은 리본", necktie: "넥타이", black_necktie: "검은 넥타이", red_necktie: "빨간 넥타이",
  ascot: "애스콧", white_ascot: "흰 애스콧", collar: "목걸이 칼라", detached_collar: "분리 칼라", choker: "초커", black_choker: "검은 초커",
  gold_choker: "금 초커", scarf: "목도리", jewelry: "장신구", earrings: "귀걸이", necklace: "목걸이", bracelet: "팔찌", ring: "반지",
  piercing: "피어싱", ear_piercing: "귀 피어싱", belt: "벨트", black_belt: "검은 벨트", chain: "사슬", tassel: "술 장식", bell: "방울",
  glasses: "안경", round_eyewear: "동그란 안경", sunglasses: "선글라스", tinted_eyewear: "색안경", eyewear_on_head: "머리에 올린 안경",
  goggles: "고글", goggles_on_head: "머리에 올린 고글", mask: "가면", mouth_mask: "입 마스크", headphones: "헤드폰", bandages: "붕대",
  nail_polish: "매니큐어", black_nails: "검은 손톱", blue_nails: "파란 손톱", red_nails: "빨간 손톱", pink_nails: "분홍 손톱",
  toenail_polish: "발톱 매니큐어", bag: "가방", black_bag: "검은 가방", shoulder_bag: "숄더백", backpack: "배낭",
  weapon: "무기", sword: "검", gun: "총", handgun: "권총", phone: "휴대폰", cellphone: "휴대전화", smartphone: "스마트폰", book: "책",
  cup: "컵", bottle: "병", food: "음식", fruit: "과일", flower: "꽃", white_flower: "흰 꽃", red_flower: "빨간 꽃", rose: "장미",
  feathers: "깃털",
};

const POSE: Record<string, string> = {
  looking_at_viewer: "정면 응시", looking_at_another: "서로 바라봄", looking_back: "뒤돌아봄", looking_to_the_side: "옆을 봄",
  smile: "미소", grin: "활짝 웃음", ":d": "활짝 웃는 입", "^_^": "눈웃음", ":3": "고양이 입", blush: "홍조", blush_stickers: "볼 홍조 표시",
  open_mouth: "벌린 입", closed_mouth: "다문 입", parted_lips: "살짝 벌린 입", tongue_out: "혀 내밂", closed_eyes: "감은 눈",
  one_eye_closed: "윙크", tears: "눈물", crying: "울음", sweat: "땀", sweatdrop: "식은땀", flying_sweatdrops: "튀는 땀방울",
  anger_vein: "화난 표시", trembling: "떨림", sleeping: "잠", eating: "먹는 중", wet: "젖음",
  standing: "선 자세", sitting: "앉은 자세", lying: "누운 자세", on_back: "등 대고 누움", on_side: "옆으로 누움", kneeling: "무릎 꿇음",
  squatting: "쪼그려 앉음", standing_on_one_leg: "한 발로 섬", leaning_forward: "몸 숙임", crossed_legs: "다리 꼬기", knees_up: "무릎 세움",
  leg_up: "다리 올림", hand_up: "손 올림", hands_up: "양손 올림", arm_up: "팔 올림", arms_up: "양팔 올림", arms_behind_back: "뒷짐",
  crossed_arms: "팔짱", hand_on_own_hip: "허리에 손", own_hands_together: "두 손 모음", v: "브이", double_v: "더블 브이",
  hug: "포옹", kiss: "키스", holding_hands: "손잡기", holding: "들고 있음", holding_weapon: "무기를 듦", holding_gun: "총을 듦",
  holding_sword: "검을 듦", holding_phone: "휴대폰을 듦", holding_cup: "컵을 듦", holding_food: "음식을 듦", holding_book: "책을 듦",
  holding_bag: "가방을 듦",
};

const SEX: Record<string, string> = {
  nipples: "유두", covered_nipples: "옷 위 유두", areola_slip: "유륜 노출", large_areolae: "큰 유륜", cleavage: "가슴골",
  sideboob: "옆가슴", underboob: "밑가슴", ass: "엉덩이", nude: "나체", completely_nude: "완전 나체", pussy: "음부", pussy_juice: "애액",
  pubic_hair: "음모", female_pubic_hair: "여성 음모", penis: "음경", erection: "발기", anus: "항문", cum: "정액", sex: "성행위",
  vaginal: "삽입", sex_from_behind: "후배위", hetero: "이성 간", yuri: "백합", clothed_female_nude_male: "옷 입은 여성·벗은 남성",
  spread_legs: "다리 벌림", clothes_lift: "옷 들추기", "see-through_clothes": "비치는 옷", skindentation: "살 파임",
  steaming_body: "달아오른 몸", saliva: "침", censored: "검열", mosaic_censoring: "모자이크", bar_censor: "막대 검열", uncensored: "무검열",
};

const SCENE: Record<string, string> = {
  simple_background: "단색 배경", white_background: "흰 배경", grey_background: "회색 배경", black_background: "검은 배경",
  blue_background: "파란 배경", pink_background: "분홍 배경", red_background: "빨간 배경", yellow_background: "노란 배경",
  gradient_background: "그라데이션 배경", blurry_background: "흐린 배경", blurry: "흐림", border: "테두리", white_border: "흰 테두리",
  outside_border: "테두리 밖", full_body: "전신", upper_body: "상반신", cowboy_shot: "허벅지 위 구도", portrait: "얼굴 위주",
  cropped_torso: "잘린 몸통", cropped_legs: "잘린 다리", feet_out_of_frame: "발 잘림", from_above: "위에서 본 구도",
  from_side: "옆에서 본 구도", from_behind: "뒤에서 본 구도", profile: "옆모습", pov: "1인칭 시점", multiple_views: "여러 시점",
  outdoors: "실외", indoors: "실내", day: "낮", night: "밤", sky: "하늘", blue_sky: "파란 하늘", cloud: "구름", water: "물", ocean: "바다",
  beach: "해변", tree: "나무", grass: "풀", plant: "식물", building: "건물", window: "창문", curtains: "커튼", bed: "침대",
  on_bed: "침대 위", bed_sheet: "침대 시트", pillow: "베개", couch: "소파", chair: "의자", table: "탁자", shadow: "그림자",
  reflection: "반사", sparkle: "반짝임", "star_(symbol)": "별 기호", heart: "하트", musical_note: "음표", blood: "피",
  motion_lines: "움직임 선", monochrome: "흑백", greyscale: "회색조", spot_color: "부분 채색", sketch: "스케치", realistic: "실사풍",
  chibi: "치비", chibi_inset: "치비 삽화", chibi_only: "치비만", comic: "만화", "2koma": "2컷 만화", speech_bubble: "말풍선",
  thought_bubble: "생각 풍선", spoken_ellipsis: "말없음표 풍선", spoken_question_mark: "물음표 풍선", "...": "말줄임표", "?": "물음표",
  english_text: "영어 글자", korean_text: "한국어 글자", chinese_text: "중국어 글자", science_fiction: "SF", no_humans: "사람 없음",
};

const ETC: Record<string, string> = {
  virtual_youtuber: "버튜버", faceless: "얼굴 없음", faceless_male: "얼굴 없는 남성", robot: "로봇", animal: "동물", bird: "새",
  cat: "고양이", "pokemon_(creature)": "포켓몬",
};

/** Present in the tagger output but not shown: they describe the file, not the picture. */
export const HIDDEN_TAGS: ReadonlySet<string> = new Set([
  "twitter_username", "weibo_watermark", "weibo_logo", "artist_name", "signature", "watermark", "logo", "character_name",
  "copyright_name", "web_address", "patreon_username", "pixiv_username", "dated",
]);

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
