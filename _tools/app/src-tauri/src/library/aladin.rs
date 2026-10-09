use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedVolumeProduct {
    pub volume_number: i64,
    pub base_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AladinItem {
    pub item_id: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub isbn13: Option<String>,
    pub publication_date: Option<String>,
    pub item_url: Option<String>,
    pub volume_number: i64,
    pub base_title: String,
    pub snapshot_json: String,
}

/// How one product title reads as a volume of a series. Mirrored by
/// `server/lakomics-api/collection_bindings.py classify_product`; change both together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProductKind {
    /// A numbered volume ("던전밥 12권").
    Volume(ParsedVolumeProduct),
    /// A product with no volume number ("봇치 더 록!", "마법소녀를 (애장판)"): the base title
    /// is the cleaned title. Grouping turns it into volume 1 of its series, or of its own
    /// one-volume series (`UNNUMBERED_VOLUME`).
    Unnumbered(String),
    /// Not a volume: a set, box, guide, novel, range, split (상/하) or a number that cannot
    /// be read.
    Excluded,
}

/// `AladinItem::volume_number` of an unnumbered product until grouping resolves it to 1.
pub(crate) const UNNUMBERED_VOLUME: i64 = 0;

const EDITION_WORDS: &str = "초회한정판|초회판|초판|특별한정판|한정판|특별판|애장판|일반판|특장판|리커버판|리커버|완전판|신장판|개정증보판|개정판|통상판|소장판|보급판";
/// A trailing parenthesised or bracketed note that is an edition marker, not an alt title.
const EDITION_NOTE_STEMS: &str = "한정|특전|특별|초회|초판|리커버|애장|완전판|신장|개정|통상|일반판|특장|소장판|보급판|에디션|edition|special|limited";

static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+\.\d+").unwrap());
static EDITION_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\s*(?:[-–—]\s*)?(?:\([^)]*(?:{notes})[^)]*\)|\[[^\]]*(?:{notes})[^\]]*\]|(?:(?:초회|초판)\s*)?(?:{words}))\s*$",
        notes = EDITION_NOTE_STEMS,
        words = EDITION_WORDS,
    ))
    .unwrap()
});
static EDITION_NOTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i)(?:{EDITION_NOTE_STEMS})")).unwrap());
static SERIES_NOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?i)\d+\s*부|외전|시즌|번외|단편|리부트|신장|part|season|side story|extra|reboot|new edition|外伝|番外|短編|新装|シーズン|リブート"
).unwrap());
static COMPLETION_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*[\(\[]\s*완결\s*[\)\]]\s*$").unwrap());
static PART_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\(\[]\s*(?:상|중|하)(?:권)?\s*[\)\]]\s*$").unwrap());
static RANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d+\s*[~∼～〜]\s*\d+|\d+\s*권?\s*[-–—]\s*\d+\s*권|\d+\s*[-–—]\s*\d+\s*$|전\s*\d+\s*권").unwrap()
});
static VOLUME_PATTERNS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        r"(?i)(?:\s|^)(?:제\s*)?(\d+)\s*권\s*$",
        r"(?i)(?:\s|^)(?:vol(?:ume)?\.?)\s*(\d+)\s*$",
        r"(?:\s|-)(\d+)\s*$",
    ]
    .map(|pattern| Regex::new(pattern).unwrap())
});

/// Words that make a whole token a non-volume product. Compared on tokens (runs of
/// letters and digits), never as substrings, so "소설가의" is not "소설".
const EXCLUDED_TOKENS: &[&str] = &[
    "소설", "소설판", "소설책", "노벨", "라이트노벨", "화집", "화보집", "설정집", "팬북", "아트북",
    "일러스트북", "일러스트집", "가이드북", "셀렉션", "캘린더", "달력", "박스세트", "guide",
    "guidebook", "novel", "novels", "calendar", "artbook", "boxset",
];
/// Compound nouns that end in one of these are products too ("공식가이드북", "탁상캘린더").
const EXCLUDED_SUFFIXES: &[&str] = &[
    "가이드북", "설정집", "일러스트북", "일러스트집", "아트북", "화보집", "캘린더", "박스세트", "풀세트",
];
const SET_PRECEDERS: &[&str] = &["박스", "전권", "완결", "합본", "풀", "스페셜", "특별", "한정", "한정판"];
const BOX_FOLLOWERS: &[&str] = &["세트", "에디션", "패키지", "한정판", "특별판"];
const GUIDE_PRECEDERS: &[&str] = &["공식", "공략", "완전", "비주얼", "캐릭터", "오피셜", "팬", "퍼펙트"];

fn is_count_token(token: &str) -> bool {
    let digits = token.strip_prefix('전').unwrap_or(token);
    digits
        .strip_suffix('권')
        .is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}

fn is_excluded_product(title: &str) -> bool {
    let lower = title.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    let last = tokens.len().saturating_sub(1);
    for (index, token) in tokens.iter().copied().enumerate() {
        let previous = index.checked_sub(1).map(|i| tokens[i]);
        let next = tokens.get(index + 1).copied();
        if EXCLUDED_TOKENS.contains(&token)
            || EXCLUDED_SUFFIXES.iter().any(|suffix| token.ends_with(suffix))
        {
            return true;
        }
        match token {
            // A set marker only ends the title or follows a count / box word; a title that
            // merely contains "세트" before its volume number ("우리들의 세트 2") is a series.
            "세트"
                if index == last
                    || previous.is_some_and(|p| SET_PRECEDERS.contains(&p) || is_count_token(p)) =>
            {
                return true
            }
            "박스" if index == last || next.is_some_and(|n| BOX_FOLLOWERS.contains(&n)) => {
                return true
            }
            "가이드" if index == last || previous.is_some_and(|p| GUIDE_PRECEDERS.contains(&p)) => {
                return true
            }
            "box" if next == Some("set") => return true,
            "art" if next == Some("book") => return true,
            _ => {}
        }
        if token.chars().count() > 2 && token.ends_with("세트") {
            return true;
        }
    }
    false
}

/// Whether the text inside a trailing `(...)` is an edition marker rather than an alt title.
pub(crate) fn is_edition_note(note: &str) -> bool {
    EDITION_NOTE.is_match(note)
}

/// Parts, side stories, seasons and new editions can identify different series.
/// Preserve them even when a provider also calls the same note a special edition.
pub(crate) fn is_series_note(note: &str) -> bool {
    SERIES_NOTE.is_match(note)
}

/// Strips trailing completion and edition markers ("24(완결)", "3권 특별판", "(애장판)").
fn strip_trailing_markers(title: &str) -> String {
    let mut current = title.trim().to_owned();
    for _ in 0..4 {
        let without_completion = COMPLETION_SUFFIX.replace(&current, "");
        let stripped = match EDITION_SUFFIX.find(&without_completion) {
            Some(note) if !is_series_note(note.as_str()) =>
                without_completion[..note.start()].trim_end().to_owned(),
            _ => without_completion.trim_end().to_owned(),
        };
        if stripped == current {
            break;
        }
        current = stripped;
    }
    current
}

pub(crate) fn classify_product(title: &str) -> ProductKind {
    if DECIMAL.is_match(title) {
        return ProductKind::Excluded;
    }
    let cleaned = strip_trailing_markers(title);
    if cleaned.is_empty()
        || RANGE.is_match(&cleaned)
        || PART_MARK.is_match(&cleaned)
        || is_excluded_product(&cleaned)
    {
        return ProductKind::Excluded;
    }
    for regex in VOLUME_PATTERNS.iter() {
        let Some(captures) = regex.captures(&cleaned) else {
            continue;
        };
        let Some(volume_number) = captures
            .get(1)
            .and_then(|digits| digits.as_str().parse::<i64>().ok())
            .filter(|number| (1..=999).contains(number))
        else {
            return ProductKind::Excluded;
        };
        let Some(matched) = captures.get(0) else {
            return ProductKind::Excluded;
        };
        let base_title = cleaned[..matched.start()]
            .trim_end_matches([' ', '-', '.'])
            .trim()
            .to_owned();
        if base_title.is_empty() {
            return ProductKind::Excluded;
        }
        return ProductKind::Volume(ParsedVolumeProduct {
            volume_number,
            base_title,
        });
    }
    ProductKind::Unnumbered(cleaned)
}

/// The numbered reading of a title, or `None` for anything else.
#[cfg(test)]
pub(crate) fn parse_volume_product(title: &str) -> Option<ParsedVolumeProduct> {
    match classify_product(title) {
        ProductKind::Volume(parsed) => Some(parsed),
        _ => None,
    }
}

impl ProductKind {
    /// `(volume number, base title)` of a usable product; `None` when excluded.
    pub(crate) fn into_volume(self) -> Option<(i64, String)> {
        match self {
            ProductKind::Volume(parsed) => Some((parsed.volume_number, parsed.base_title)),
            ProductKind::Unnumbered(base_title) => Some((UNNUMBERED_VOLUME, base_title)),
            ProductKind::Excluded => None,
        }
    }
}

/// A provider search: the usable products and how many were left out as non-volumes.
#[derive(Debug, Default)]
pub(crate) struct SearchOutcome {
    pub items: Vec<AladinItem>,
    pub unparsed_count: u64,
}

/// The query with punctuation turned into spaces ("공주님, '고문'의 시간입니다" becomes
/// "공주님 고문 의 시간입니다"): the retry when the provider finds nothing for the exact text.
/// Mirrored by `collection_bindings.py normalize_search_query`.
pub(crate) fn normalize_search_query(query: &str) -> String {
    query
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{classify_product, parse_volume_product, normalize_search_query, ProductKind};

    #[test]
    fn punctuation_retry_query_is_normalized() {
        assert_eq!(normalize_search_query("공주님, '고문'의 시간입니다"), "공주님 고문 의 시간입니다");
    }

    #[test]
    fn parses_integer_volume_suffixes() {
        assert_eq!(
            parse_volume_product("던전밥 12권").unwrap().volume_number,
            12
        );
        assert_eq!(
            parse_volume_product("던전밥 Vol. 12")
                .unwrap()
                .volume_number,
            12
        );
        assert_eq!(
            parse_volume_product("던전밥 제12권").unwrap().volume_number,
            12
        );
        assert_eq!(
            parse_volume_product("던전밥 Volume 12")
                .unwrap()
                .volume_number,
            12
        );
    }

    #[test]
    fn parses_volume_numbers_before_edition_suffixes() {
        for (title, volume_number) in [
            ("던전밥 3권 특별판", 3),
            ("던전밥 4 - 초판 한정판", 4),
            ("던전밥 Vol. 5 (한정판)", 5),
        ] {
            let parsed = parse_volume_product(title).unwrap();
            assert_eq!(parsed.base_title, "던전밥", "{title}");
            assert_eq!(parsed.volume_number, volume_number, "{title}");
        }
    }

    #[test]
    fn rejects_special_products_and_fractional_volumes() {
        for title in [
            "던전밥 박스 세트",
            "던전밥 공식 가이드북",
            "던전밥 10.5권",
            "던전밥 화집 2",
            "던전밥 소설 3권",
            "던전밥 1000권",
        ] {
            assert_eq!(parse_volume_product(title), None, "{title}");
        }
    }

    #[test]
    fn korean_completion_and_dotted_volume_titles_are_recognized() {
        for (title, number) in [("스틸 볼 런 24(완결)", 24), ("스틸 볼 런. 23", 23)] {
            let parsed = parse_volume_product(title).unwrap();
            assert_eq!(parsed.volume_number, number);
            assert_eq!(parsed.base_title, "스틸 볼 런");
        }
        assert!(parse_volume_product("학생회에도 구멍은 있다! 공식 일러스트북").is_none());
        assert!(parse_volume_product("학생회에도 구멍은 있다! 공식 풀컬러판 구멍 셀렉션!").is_none());
    }

    fn volume(title: &str) -> (i64, String) {
        match classify_product(title) {
            ProductKind::Volume(parsed) => (parsed.volume_number, parsed.base_title),
            other => panic!("{title}: {other:?}"),
        }
    }

    #[test]
    fn edition_suffixes_are_stripped_from_numbered_and_unnumbered_titles() {
        for (title, expected) in [
            ("마법소녀를 3 (애장판)", (3, "마법소녀를")),
            ("마법소녀를 3권 (일반판)", (3, "마법소녀를")),
            ("마법소녀를 4 (특장판)", (4, "마법소녀를")),
            ("마법소녀를 5 리커버", (5, "마법소녀를")),
            ("마법소녀를 6 [완전판]", (6, "마법소녀를")),
            ("마법소녀를 7 (초회 한정 특전판)", (7, "마법소녀를")),
            ("마법소녀를 8 (특별판)(완결)", (8, "마법소녀를")),
            ("마법소녀를 9(완결) 한정판", (9, "마법소녀를")),
        ] {
            assert_eq!(volume(title), (expected.0, expected.1.to_owned()), "{title}");
        }
        for (title, base) in [
            ("마법소녀를 (애장판)", "마법소녀를"),
            ("마법소녀를 (일반판)", "마법소녀를"),
            ("마법소녀를 리커버", "마법소녀를"),
            ("봇치 더 록!", "봇치 더 록!"),
            ("위치 워치(Witch Watch)", "위치 워치(Witch Watch)"),
        ] {
            assert_eq!(
                classify_product(title),
                ProductKind::Unnumbered(base.to_owned()),
                "{title}"
            );
        }
    }

    /// The rows the server's `classify_product` is tested against too
    /// (`server/lakomics-api/tests/test_collection_bindings.py`).
    #[test]
    fn product_titles_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/product_titles.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 50);
        for case in cases {
            let title = case["title"].as_str().unwrap();
            let expected = match case["kind"].as_str().unwrap() {
                "volume" => ProductKind::Volume(super::ParsedVolumeProduct {
                    volume_number: case["volume"].as_i64().unwrap(),
                    base_title: case["base"].as_str().unwrap().to_owned(),
                }),
                "unnumbered" => ProductKind::Unnumbered(case["base"].as_str().unwrap().to_owned()),
                "excluded" => ProductKind::Excluded,
                other => panic!("{other}"),
            };
            assert_eq!(classify_product(title), expected, "{title}");
        }
    }

    #[test]
    fn alt_titles_in_parentheses_keep_the_volume_number() {
        assert_eq!(
            volume("위치 워치(Witch Watch) 2"),
            (2, "위치 워치(Witch Watch)".to_owned())
        );
    }

    #[test]
    fn excluded_words_match_whole_words_not_parts_of_real_titles() {
        for title in [
            "오타쿠 소설가의 일상 1",
            "가이드 걸 1",
            "우리들의 세트 2",
            "달력소녀 3",
            "박스 안의 고양이 4",
        ] {
            assert!(
                matches!(classify_product(title), ProductKind::Volume(_)),
                "{title}: {:?}",
                classify_product(title)
            );
        }
        for title in [
            "던전밥 1-5권 세트",
            "던전밥 박스 세트",
            "던전밥 박스세트 1",
            "던전밥 공식 가이드북",
            "던전밥 공식 가이드 1",
            "던전밥 소설판",
            "던전밥 소설 3",
            "던전밥 일러스트북",
            "던전밥 1~5",
            "던전밥 전 5권",
            "던전밥 (상)",
            "던전밥 (하)",
            "던전밥 1.5",
            "던전밥 1000",
            "던전밥 세트",
            "Dungeon Meshi Box Set",
            "Dungeon Meshi Art Book",
            "Dungeon Meshi Guide",
            "1권",
        ] {
            assert_eq!(classify_product(title), ProductKind::Excluded, "{title}");
        }
    }

    #[test]
    fn unnumbered_products_are_kept_with_their_cleaned_title() {
        let items: Vec<(i64, String)> = [
            "오타쿠 소설가의 일상 1",
            "단편 한 권짜리 이야기",
            "던전밥 (일반판)",
            "던전밥 박스 세트",
        ]
        .iter()
        .filter_map(|title| classify_product(title).into_volume())
        .collect();
        assert_eq!(
            items
                .iter()
                .map(|(number, title)| (*number, title.as_str()))
                .collect::<Vec<_>>(),
            [
                (1, "오타쿠 소설가의 일상"),
                (super::UNNUMBERED_VOLUME, "단편 한 권짜리 이야기"),
                (super::UNNUMBERED_VOLUME, "던전밥"),
            ]
        );
    }
}
