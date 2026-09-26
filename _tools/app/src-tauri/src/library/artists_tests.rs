//! Artist hub tests: tiers, 초성 search, merge/split, assignment precedence, source fill.

use rusqlite::{params, Connection};

use super::artists::{self, ArtistBucket, ArtistListQuery, ArtistSettings, ArtistSort};
use super::error::LibraryError;
use super::models::AssetQuery;
use super::Library;

const NOW: &str = "2026-09-26T12:00:00Z";

fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

struct Asset<'a> {
    id: &'a str,
    collected_at: &'a str,
    name: Option<&'a str>,
    handle: Option<&'a str>,
    creator_url: Option<&'a str>,
    source_url: Option<&'a str>,
}

impl<'a> Asset<'a> {
    fn new(id: &'a str) -> Self {
        Self {
            id,
            collected_at: "2026-01-01T00:00:00Z",
            name: None,
            handle: None,
            creator_url: None,
            source_url: None,
        }
    }
    fn by(mut self, name: &'a str, handle: &'a str) -> Self {
        self.name = Some(name);
        self.handle = Some(handle);
        self
    }
    fn at(mut self, collected_at: &'a str) -> Self {
        self.collected_at = collected_at;
        self
    }
    fn creator_url(mut self, url: &'a str) -> Self {
        self.creator_url = Some(url);
        self
    }
    fn source(mut self, url: &'a str) -> Self {
        self.source_url = Some(url);
        self
    }
}

fn insert(connection: &Connection, asset: Asset<'_>) {
    connection
        .execute(
            "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path,
                byte_size, width, height, collected_at, creator_name, creator_handle, creator_url, source_url)
             VALUES (?1, ?1, 'image', ?1, 'assets/' || ?1, 'thumbnails/' || ?1 || '.webp', 1, 10, 10, ?2, ?3, ?4, ?5, ?6)",
            params![asset.id, asset.collected_at, asset.name, asset.handle, asset.creator_url, asset.source_url],
        )
        .unwrap();
}

fn insert_many(
    connection: &Connection,
    prefix: &str,
    count: usize,
    name: &str,
    handle: &str,
    collected_at: &str,
) {
    for index in 0..count {
        insert(
            connection,
            Asset::new(&format!("{prefix}-{index}"))
                .by(name, handle)
                .at(collected_at),
        );
    }
}

fn list(connection: &Connection, bucket: ArtistBucket, search: Option<&str>) -> Vec<(String, u32)> {
    artists::list(
        connection,
        &ArtistListQuery {
            bucket,
            search: search.map(str::to_owned),
            sort: ArtistSort::Count,
            ..Default::default()
        },
        NOW,
    )
    .unwrap()
    .artists
    .into_iter()
    .map(|artist| (artist.label, artist.asset_count))
    .collect()
}

fn scoped_ids(library: &Library, scope: &str) -> Vec<String> {
    let mut ids: Vec<String> = library
        .list_assets(AssetQuery {
            creator_key: Some(scope.to_owned()),
            limit: 200,
            ..Default::default()
        })
        .unwrap()
        .items
        .into_iter()
        .map(|asset| asset.id)
        .collect();
    ids.sort();
    ids
}

fn creator_fields(
    connection: &Connection,
) -> Vec<(String, Option<String>, Option<String>, Option<String>)> {
    connection
        .prepare("SELECT id, creator_name, creator_handle, creator_url FROM assets ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn tiers_split_main_and_other_by_count_or_recent_saves() {
    let (_temp, library) = fixture();
    let connection = library.connection().unwrap();
    insert_many(&connection, "big", 5, "Big", "big", "2025-01-01T00:00:00Z");
    insert_many(
        &connection,
        "recent",
        2,
        "Recent",
        "recent",
        "2026-09-20T00:00:00Z",
    );
    insert_many(
        &connection,
        "pair",
        2,
        "Pair",
        "pair",
        "2025-01-01T00:00:00Z",
    );
    insert_many(&connection, "one", 1, "One", "one", "2025-01-01T00:00:00Z");
    insert(&connection, Asset::new("unknown"));
    insert(
        &connection,
        Asset::new("forum").source("https://arca.live/b/art/1"),
    );

    let overview = artists::overview(&connection, NOW).unwrap();
    assert_eq!(overview.settings, ArtistSettings::default());
    assert_eq!(
        (
            overview.total,
            overview.main,
            overview.other,
            overview.two_to_four,
            overview.single
        ),
        (4, 2, 2, 1, 1)
    );
    assert_eq!((overview.unknown_none, overview.unknown_source), (1, 1));
    assert_eq!(
        list(&connection, ArtistBucket::Main, None),
        vec![("Big".into(), 5), ("Recent".into(), 2)]
    );
    assert_eq!(
        list(&connection, ArtistBucket::Single, None),
        vec![("One".into(), 1)]
    );

    // The rule is a stored setting.
    artists::set_settings(
        &connection,
        ArtistSettings {
            main_min_count: 2,
            recent_min_count: 9,
            recent_days: 30,
        },
    )
    .unwrap();
    assert_eq!(artists::overview(&connection, NOW).unwrap().main, 3);
    assert!(matches!(
        artists::set_settings(
            &connection,
            ArtistSettings {
                main_min_count: 0,
                recent_min_count: 1,
                recent_days: 1
            }
        ),
        Err(LibraryError::InvalidArtist(_))
    ));

    artists::set_settings(&connection, ArtistSettings::default()).unwrap();
    // Pinned artists leave the tier lists; hidden artists leave everything but 숨긴 작가.
    artists::set_flags(&connection, "big", Some(true), None, NOW).unwrap();
    artists::set_flags(&connection, "one", None, Some(true), NOW).unwrap();
    let overview = artists::overview(&connection, NOW).unwrap();
    assert_eq!(
        overview
            .pinned
            .iter()
            .map(|artist| artist.label.as_str())
            .collect::<Vec<_>>(),
        vec!["Big"]
    );
    assert_eq!(
        (
            overview.total,
            overview.main,
            overview.hidden,
            overview.single
        ),
        (3, 1, 1, 0)
    );
    assert_eq!(
        list(&connection, ArtistBucket::Hidden, None),
        vec![("One".into(), 1)]
    );
    assert!(list(&connection, ArtistBucket::All, Some("One")).is_empty());
    assert_eq!(
        list(&connection, ArtistBucket::All, None)[0].0,
        "Big",
        "pinned first"
    );
}

#[test]
fn search_matches_names_handles_and_initial_consonants() {
    assert!(artists::matches_search("서리", "ㅅㄹ"));
    assert!(artists::matches_search("소리꾼", "ㅅㄹ"));
    assert!(artists::matches_search("하늘고래", "하ㄴ"));
    assert!(artists::matches_search("Kiri_Draws", "kiri"));
    assert!(artists::matches_search("@sky_whale", "@SKY"));
    assert!(!artists::matches_search("수련", "ㅅㄹㄱ"));
    assert!(!artists::matches_search("Nori", "ㄴ"));

    let (_temp, library) = fixture();
    let connection = library.connection().unwrap();
    insert(&connection, Asset::new("a").by("서리", "seori_ink"));
    insert(&connection, Asset::new("b").by("하늘고래", "sky_whale"));
    insert(&connection, Asset::new("c").by("Nori", "nori_sketch"));
    assert_eq!(
        list(&connection, ArtistBucket::All, Some("ㅅㄹ")),
        vec![("서리".into(), 1)]
    );
    assert_eq!(
        list(&connection, ArtistBucket::All, Some("sky_")),
        vec![("하늘고래".into(), 1)]
    );
    // A user-defined name is searchable, and the source name still finds the artist.
    artists::set_display_name(&connection, "nori_sketch", Some("노리"), NOW).unwrap();
    assert_eq!(
        list(&connection, ArtistBucket::All, Some("ㄴㄹ")),
        vec![("노리".into(), 1)]
    );
    assert_eq!(
        list(&connection, ArtistBucket::All, Some("nori")),
        vec![("노리".into(), 1)]
    );
}

#[test]
fn rename_creates_a_row_and_clearing_it_returns_to_the_implicit_key() {
    let (_temp, library) = fixture();
    let connection = library.connection().unwrap();
    insert(
        &connection,
        Asset::new("a").by("Moonshade", "moonshade_art"),
    );
    let id =
        artists::set_display_name(&connection, "moonshade_art", Some("  달그림자 "), NOW).unwrap();
    assert!(id.starts_with("artist:"));
    let summary = &artists::list(&connection, &ArtistListQuery::default(), NOW)
        .unwrap()
        .artists[0];
    assert_eq!(
        (summary.label.as_str(), summary.source_name.as_deref()),
        ("달그림자", Some("Moonshade"))
    );
    assert_eq!(
        artists::caption_labels(&connection)
            .unwrap()
            .by_key
            .get("moonshade_art")
            .map(String::as_str),
        Some("달그림자")
    );

    assert_eq!(
        artists::set_display_name(&connection, &id, None, NOW).unwrap(),
        "moonshade_art"
    );
    let rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM artists", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    assert!(matches!(
        artists::set_display_name(&connection, "missing", Some("x"), NOW),
        Err(LibraryError::ArtistNotFound)
    ));
    assert!(matches!(
        artists::set_display_name(&connection, "unknown:none", Some("x"), NOW),
        Err(LibraryError::InvalidArtist(_))
    ));
}

#[test]
fn merge_and_split_move_keys_and_the_asset_filter_follows() {
    let (_temp, library) = fixture();
    {
        let connection = library.connection().unwrap();
        insert_many(
            &connection,
            "x",
            3,
            "Moonshade",
            "moonshade_art",
            "2025-01-01T00:00:00Z",
        );
        insert(
            &connection,
            Asset::new("p-0")
                .by("月影", "48213377")
                .creator_url("https://www.pixiv.net/users/48213377"),
        );
        insert(&connection, Asset::new("other").by("Other", "other"));
    }
    let merged = {
        let connection = library.connection().unwrap();
        artists::merge(
            &connection,
            "moonshade_art",
            &["48213377".into()],
            Some("달그림자"),
            NOW,
        )
        .unwrap()
    };
    let connection = library.connection().unwrap();
    assert_eq!(
        list(&connection, ArtistBucket::All, None),
        vec![("달그림자".into(), 4), ("Other".into(), 1)]
    );
    let detail = artists::detail(&connection, &merged, "2026-09-26", 540, NOW).unwrap();
    assert_eq!(
        detail
            .members
            .iter()
            .map(|member| (member.key.as_str(), member.host.as_deref()))
            .collect::<Vec<_>>(),
        vec![("moonshade_art", None), ("48213377", Some("pixiv"))]
    );
    drop(connection);
    let everything = vec!["p-0".to_string(), "x-0".into(), "x-1".into(), "x-2".into()];
    assert_eq!(scoped_ids(&library, &merged), everything);
    // A bare key of a merged artist opens the whole artist.
    assert_eq!(scoped_ids(&library, "48213377"), everything);

    let connection = library.connection().unwrap();
    let after = artists::detach_member(&connection, &merged, "48213377", NOW).unwrap();
    assert_eq!(after, merged, "the named artist keeps its row");
    assert_eq!(
        list(&connection, ArtistBucket::All, None),
        vec![
            ("달그림자".into(), 3),
            ("Other".into(), 1),
            ("月影".into(), 1)
        ]
    );
    // Detached keys are kept apart from then on.
    let dismissed: i64 = connection
        .query_row("SELECT COUNT(*) FROM artist_merge_dismissals WHERE key_a = '48213377' AND key_b = 'moonshade_art'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(dismissed, 1);
    drop(connection);
    assert_eq!(scoped_ids(&library, "48213377"), vec!["p-0".to_string()]);

    // Merging two explicit artists folds names, pins and rows into the target.
    let connection = library.connection().unwrap();
    let other = artists::set_flags(&connection, "other", Some(true), None, NOW).unwrap();
    let result = artists::merge(&connection, &merged, &[other], None, NOW).unwrap();
    let summary = artists::list(&connection, &ArtistListQuery::default(), NOW)
        .unwrap()
        .artists
        .into_iter()
        .find(|artist| artist.id == result)
        .unwrap();
    assert_eq!(
        (summary.label.as_str(), summary.asset_count, summary.pinned),
        ("달그림자", 4, true)
    );
    let rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM artists", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn an_assignment_takes_precedence_over_the_creator_key() {
    let (_temp, library) = fixture();
    {
        let connection = library.connection().unwrap();
        insert_many(
            &connection,
            "kiri",
            2,
            "Kiri",
            "kiri_draws",
            "2025-01-01T00:00:00Z",
        );
        insert(&connection, Asset::new("blank"));
    }
    let target = {
        let connection = library.connection().unwrap();
        let target = artists::assign_assets(
            &connection,
            &["kiri-1".into(), "blank".into()],
            None,
            Some("하늘빛"),
            NOW,
        )
        .unwrap();
        assert!(matches!(
            artists::assign_assets(&connection, &[], None, Some("x"), NOW),
            Err(LibraryError::EmptyAssetSelection)
        ));
        assert!(matches!(
            artists::assign_assets(&connection, &["nope".into()], None, Some("x"), NOW),
            Err(LibraryError::AssetNotFound)
        ));
        assert_eq!(
            list(&connection, ArtistBucket::All, None),
            vec![("하늘빛".into(), 2), ("Kiri".into(), 1)]
        );
        let overview = artists::overview(&connection, NOW).unwrap();
        assert_eq!(overview.unknown_none, 0);
        let detail = artists::detail(&connection, &target, "2026-09-26", 0, NOW).unwrap();
        assert_eq!(
            detail
                .assignments
                .iter()
                .map(|info| (info.source.as_str(), info.asset_count))
                .collect::<Vec<_>>(),
            vec![("manual", 2)]
        );
        assert_eq!(
            artists::caption_labels(&connection)
                .unwrap()
                .by_asset
                .get("blank")
                .map(String::as_str),
            Some("하늘빛")
        );
        target
    };
    assert_eq!(
        scoped_ids(&library, &target),
        vec!["blank".to_string(), "kiri-1".into()]
    );
    assert_eq!(
        scoped_ids(&library, "kiri_draws"),
        vec!["kiri-0".to_string()]
    );
    assert!(scoped_ids(&library, "unknown:none").is_empty());

    // 떼어내기 of 직접 지정 returns both images; the empty artist row goes away.
    let connection = library.connection().unwrap();
    artists::detach_assignments(&connection, &target, "manual", NOW).unwrap();
    assert_eq!(
        list(&connection, ArtistBucket::All, None),
        vec![("Kiri".into(), 2)]
    );
    let rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM artists", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    // The creator fields were never touched.
    assert_eq!(
        creator_fields(&connection)[0],
        ("blank".into(), None, None, None)
    );
}

#[test]
fn source_fill_reads_x_handles_offline_matches_existing_keys_ignoring_case_and_never_writes_creator_fields(
) {
    let (_temp, library) = fixture();
    {
        let connection = library.connection().unwrap();
        insert_many(
            &connection,
            "kiri",
            2,
            "Kiri",
            "kiri_draws",
            "2025-01-01T00:00:00Z",
        );
        insert(
            &connection,
            Asset::new("s1").source("https://x.com/Kiri_Draws/status/1"),
        );
        insert(
            &connection,
            Asset::new("s2").source("https://twitter.com/NewOne/status/2?s=20"),
        );
        insert(
            &connection,
            Asset::new("s3").source("https://x.com/newone/status/3/photo/1"),
        );
        insert(
            &connection,
            Asset::new("s4").source("https://x.com/i/web/status/4"),
        );
        insert(
            &connection,
            Asset::new("s5").source("https://www.pixiv.net/artworks/5"),
        );
        insert(
            &connection,
            Asset::new("s6").source("https://gall.dcinside.com/board/view/?id=x&no=6"),
        );
    }
    let connection = library.connection().unwrap();
    let before = creator_fields(&connection);
    let preview = artists::source_fill_preview(&connection, NOW).unwrap();
    assert_eq!(
        (
            preview.total,
            preview.fillable,
            preview.without_handle,
            preview.existing_artists,
            preview.new_artists
        ),
        (6, 3, 1, 1, 1)
    );
    let groups: Vec<_> = preview
        .groups
        .iter()
        .map(|group| {
            (
                group.handle.as_str(),
                group.asset_count,
                group.target_id.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        groups,
        vec![("NewOne", 2, None), ("kiri_draws", 1, Some("kiri_draws"))]
    );
    let sites: Vec<_> = preview
        .sites
        .iter()
        .map(|site| (site.host.as_str(), site.asset_count, site.method.as_str()))
        .collect();
    assert_eq!(
        sites,
        vec![
            ("x.com", 4, "auto"),
            ("dcinside", 1, "manual"),
            ("pixiv", 1, "manual")
        ]
    );
    assert_eq!(
        artists::overview(&connection, NOW).unwrap().source_fillable,
        3
    );

    let result = artists::apply_source_fill(&connection, NOW).unwrap();
    assert_eq!((result.assigned, result.created_artists), (3, 1));
    assert_eq!(
        creator_fields(&connection),
        before,
        "creators filled from URLs are link records only"
    );
    assert_eq!(
        list(&connection, ArtistBucket::All, None),
        vec![("Kiri".into(), 3), ("NewOne".into(), 2)]
    );
    let sources: Vec<(String, String, Option<String>)> = connection
        .prepare("SELECT asset_id, source, source_handle FROM asset_artist_assignments ORDER BY asset_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        sources[0],
        ("s1".into(), "source_url".into(), Some("kiri_draws".into()))
    );
    // Applying again finds nothing left to fill.
    assert_eq!(
        artists::apply_source_fill(&connection, NOW)
            .unwrap()
            .assigned,
        0
    );
    let overview = artists::overview(&connection, NOW).unwrap();
    assert_eq!((overview.unknown_source, overview.source_fillable), (3, 0));
    // A new save from that handle joins the filled artist.
    insert(&connection, Asset::new("later").by("New One", "NewOne"));
    assert_eq!(list(&connection, ArtistBucket::All, Some("newone"))[0].1, 3);
}

#[test]
fn merge_suggestions_are_conservative_and_dismissals_stick() {
    let (_temp, library) = fixture();
    let connection = library.connection().unwrap();
    insert_many(
        &connection,
        "a",
        3,
        "Kiri",
        "kiri_draws",
        "2025-01-01T00:00:00Z",
    );
    insert(
        &connection,
        Asset::new("b").by("키리 커미션OPEN", "Kiri_Draws"),
    );
    insert(
        &connection,
        Asset::new("c")
            .by("Hollow Lantern", "hollowlantern")
            .creator_url("https://x.com/hollowlantern"),
    );
    insert(
        &connection,
        Asset::new("d")
            .by("Hollow Lantern", "3302911")
            .creator_url("https://www.pixiv.net/users/3302911"),
    );
    insert(&connection, Asset::new("e").by("sio", "sio_mizu"));
    insert(&connection, Asset::new("f").by("시오미즈", "sio_mizu2"));
    insert(
        &connection,
        Asset::new("g")
            .by("Same", "same_one")
            .creator_url("https://x.com/same_one"),
    );
    insert(
        &connection,
        Asset::new("h")
            .by("Same", "same_two")
            .creator_url("https://x.com/same_two"),
    );
    insert(&connection, Asset::new("i").by("ab", "abc1"));
    insert(&connection, Asset::new("j").by("ab2", "abc2"));

    let suggestions = artists::merge_suggestions(&connection, NOW).unwrap();
    let kinds: Vec<_> = suggestions
        .iter()
        .map(|suggestion| {
            (
                suggestion.kind.as_str(),
                suggestion.uncertain,
                suggestion.key_a.as_str(),
                suggestion.key_b.as_str(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("handle", false, "Kiri_Draws", "kiri_draws"),
            ("name", false, "3302911", "hollowlantern"),
            ("similar", true, "sio_mizu", "sio_mizu2"),
        ]
    );
    assert_eq!(
        suggestions[0].left.label, "Kiri",
        "the larger artist is the merge target"
    );

    artists::dismiss_suggestion(&connection, "kiri_draws", "Kiri_Draws", NOW).unwrap();
    assert_eq!(
        artists::merge_suggestions(&connection, NOW).unwrap().len(),
        2
    );
    assert_eq!(
        artists::overview(&connection, NOW)
            .unwrap()
            .merge_suggestions,
        2
    );
}

#[test]
fn today_and_the_artist_page_rediscover_by_date_and_long_unseen() {
    let (_temp, library) = fixture();
    let connection = library.connection().unwrap();
    insert_many(&connection, "old", 3, "Old", "old", "2023-09-26T03:00:00Z");
    insert_many(
        &connection,
        "fresh",
        2,
        "Fresh",
        "fresh",
        "2026-09-24T03:00:00Z",
    );
    connection.execute("INSERT INTO asset_activity (asset_id, last_opened_at, open_count) VALUES ('old-0', '2026-09-01T00:00:00Z', 1)", []).unwrap();

    let detail = artists::detail(&connection, "old", "2026-09-26", 540, NOW).unwrap();
    let on_this_day = detail.on_this_day.unwrap();
    assert_eq!(
        (
            on_this_day.years_ago,
            on_this_day.local_date.as_deref(),
            on_this_day.total
        ),
        (Some(3), Some("2023-09-26"), 3)
    );
    let unseen = detail.long_unseen.unwrap();
    assert_eq!(
        unseen.total, 2,
        "the image opened this month is not long unseen"
    );
    assert!(
        artists::detail(&connection, "fresh", "2026-09-26", 540, NOW)
            .unwrap()
            .long_unseen
            .is_none()
    );

    let rows = artists::today(&connection, "2026-09-26", 540, NOW, 0, &[]).unwrap();
    let kinds: Vec<_> = rows
        .iter()
        .map(|row| {
            (
                row.kind.as_str(),
                row.artist.label.as_str(),
                row.reason.as_str(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("anniversary", "Old", "3년 전 오늘 저장"),
            ("fresh", "Fresh", "이번 주 새 작품 2장")
        ]
    );
    let rows = artists::today(&connection, "2026-09-26", 540, NOW, 0, &["old".into()]).unwrap();
    assert!(rows.iter().all(|row| row.artist.id != "old"));
}

#[test]
fn statistics_top_artists_resolve_merges_and_display_names() {
    let (_temp, library) = fixture();
    {
        let connection = library.connection().unwrap();
        insert_many(&connection, "a", 2, "A", "a_handle", "2025-01-01T00:00:00Z");
        insert_many(&connection, "b", 2, "B", "b_handle", "2025-01-01T00:00:00Z");
        insert(&connection, Asset::new("c").by("C", "c_handle"));
        artists::merge(
            &connection,
            "a_handle",
            &["b_handle".into()],
            Some("합친 작가"),
            NOW,
        )
        .unwrap();
    }
    let creators = library.get_library_statistics().unwrap().creators;
    assert_eq!(
        creators
            .iter()
            .map(|count| (count.label.as_str(), count.count))
            .collect::<Vec<_>>(),
        vec![("합친 작가", 4), ("C", 1)]
    );
}
