use super::*;
use image::{DynamicImage, Rgba, RgbaImage};

fn pattern(colors: &[[u8; 4]], size: u32) -> DynamicImage {
    DynamicImage::ImageRgba8(RgbaImage::from_fn(size, size, |x, _| {
        Rgba(colors[(x as usize * colors.len() / size as usize).min(colors.len() - 1)])
    }))
}
fn warm() -> DynamicImage {
    pattern(&[[240, 60, 20, 255], [120, 30, 10, 255]], 32)
}

#[test]
fn palettes_resize_distance_and_flat_rejection() {
    let a = color_signature(&warm()).unwrap();
    let resized =
        color_signature(&warm().resize_exact(64, 64, image::imageops::FilterType::Nearest))
            .unwrap();
    let cool = color_signature(&pattern(&[[20, 60, 240, 255], [10, 30, 120, 255]], 32)).unwrap();
    assert!(color_distance(&a, &a) < 0.00001);
    assert!(color_distance(&a, &resized) < 0.01);
    assert!(color_distance(&a, &cool) > 0.75);
    assert!(color_signature(&pattern(&[[255, 0, 0, 255]], 32)).is_none());
    assert!(color_signature(&DynamicImage::new_rgba8(0, 0)).is_none());
}

#[test]
fn hue_wrap_grayscale_and_transparency_are_stable() {
    let before = color_signature(&pattern(&[[240, 0, 10, 255], [120, 0, 5, 255]], 32)).unwrap();
    let after = color_signature(&pattern(&[[240, 10, 0, 255], [120, 5, 0, 255]], 32)).unwrap();
    assert!(color_distance(&before, &after) < 0.1);
    let gray = color_signature(&pattern(&[[30, 30, 30, 255], [200, 200, 200, 255]], 32)).unwrap();
    assert!((gray.bins[96..].iter().sum::<f32>() - 1.0).abs() < 0.001);
    let transparent = color_signature(&pattern(&[[255, 0, 0, 0], [30, 30, 30, 255]], 32)).unwrap();
    let white = color_signature(&pattern(&[[255, 255, 255, 255], [30, 30, 30, 255]], 32)).unwrap();
    assert!(color_distance(&transparent, &white) < 0.001);
}

fn fixture(count: usize) -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    {
        let connection = library.connection().unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        for index in 0..count {
            let id = format!("asset-{index:04}");
            let path = format!("thumbnails/{id}.png");
            warm().save(temp.path().join(&path)).unwrap();
            tx.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES (?1,?2,'image',?1,?3,?4,1,32,32,'2025-01-01T00:00:00Z')",
                params![id, format!("hash-{id}"), format!("assets/{id}.png"), path]).unwrap();
        }
        tx.commit().unwrap();
    }
    (temp, library)
}

#[test]
fn bounded_pages_warm_cache_and_library_isolation() {
    let (_temp, library) = fixture(65);
    let started = Instant::now();
    let first = library.prepare_color_candidates(started).unwrap();
    assert!(first.decodes <= 64);
    assert!(library.color_cache().entries.len() <= 64);
    // Tiny fixtures fit the soft budget on this test host. A second visit advances
    // the middle row instead of restarting at either edge.
    library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(library.color_cache().entries.len(), 65);
    let warm = library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(warm.decodes, 0);
    assert_eq!(warm.reads, 0);
    let (_other_temp, other) = fixture(0);
    assert!(other.color_cache().entries.is_empty());
}

#[test]
fn cache_evicts_oldest_entry_at_513() {
    let mut cache = ColorCache::default();
    for index in 0..513 {
        cache.insert(CacheEntry {
            source: ColorSource {
                id: index.to_string(),
                hash: index.to_string(),
                thumbnail: None,
                collected_at: String::new(),
            },
            stamp: None,
            signature: None,
            used: 0,
        });
    }
    assert_eq!(cache.entries.len(), CACHE_CAPACITY);
    assert!(!cache.entries.contains_key("0"));
    assert!(cache.entries.contains_key("512"));
}

#[test]
fn failed_media_is_cached_and_identity_changes_retry_without_original_fallback() {
    let (temp, library) = fixture(6);
    let paths: Vec<_> = (0..6)
        .map(|index| temp.path().join(format!("thumbnails/asset-{index:04}.png")))
        .collect();
    std::fs::remove_file(&paths[0]).unwrap();
    std::fs::write(&paths[1], b"corrupt").unwrap();
    std::fs::File::create(&paths[2])
        .unwrap()
        .set_len(MAX_BYTES + 1)
        .unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "UPDATE assets SET thumbnail_relative_path=?1 WHERE id='asset-0003'",
                [outside.path().to_str().unwrap()],
            )
            .unwrap();
        connection.execute("UPDATE assets SET media_kind='video',thumbnail_relative_path=NULL WHERE id='asset-0004'", []).unwrap();
    }
    let first = library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(first.decodes, 1);
    assert_eq!(library.current_colors().unwrap().len(), 1);
    // Reset only page cursors so exactly the same metadata is revisited.
    library.color_cache().cursors = [None, None];
    let again = library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(again.reads, 0);
    warm().save(&paths[0]).unwrap();
    warm().save(&paths[1]).unwrap();
    library.color_cache().cursors = [None, None];
    let changed = library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(changed.decodes, 2);
    assert_eq!(library.current_colors().unwrap().len(), 3);
    // Replacing a cached file and trashing an asset invalidate ready descriptors.
    std::fs::write(&paths[0], b"replacement").unwrap();
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status='trash' WHERE id='asset-0001'", [])
        .unwrap();
    assert_eq!(library.current_colors().unwrap().len(), 1);
}

#[test]
fn oversized_dimensions_are_rejected_before_pixel_decode() {
    let image = DynamicImage::new_rgb8(2_001, 1_000);
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let mut stats = PreparationStats::default();
    assert!(decode_signature(bytes.get_ref(), &mut stats).is_none());
    assert_eq!(stats.decodes, 0);
}

#[test]
fn color_publication_cas_mixed_media_preferences_and_no_alternative() {
    let (_temp, library) = fixture(12);
    let date = "2026-09-12";
    let now = "2026-09-12T10:00:00Z";
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET media_kind='video' WHERE id='asset-0000'",
            [],
        )
        .unwrap();
    library.connection().unwrap().execute("INSERT INTO video_assets(asset_id,duration_ms,container,video_codec,preparation_state,playback_kind,poster_relative_path,scrub_relative_dir) VALUES ('asset-0000',1000,'mp4','h264','ready','original','thumbnails/asset-0000.png','video-media/asset-0000/scrub')", []).unwrap();
    let base = library.get_or_create_revisit_slate(date, now).unwrap();
    assert!(base.bundles.is_empty());
    let prepared = library
        .prepare_revisit_color_bundle(date, now, base.revision)
        .unwrap()
        .unwrap();
    assert_eq!(prepared.bundles.len(), 1);
    let bundle = &prepared.bundles[0];
    assert_eq!(bundle.kind, "color");
    assert_eq!(bundle.asset_ids.len(), 12);
    assert_ne!(bundle.asset_ids[0], "asset-0000");
    assert!(bundle.asset_ids.contains(&"asset-0000".to_string()));
    assert_eq!(prepared.revision, base.revision + 1);
    assert!(library
        .prepare_revisit_color_bundle(date, now, prepared.revision)
        .unwrap()
        .is_none());
    assert!(library
        .prepare_revisit_color_bundle(date, now, base.revision)
        .unwrap()
        .is_none());
    let reshuffled = library
        .reshuffle_revisit_bundle(date, &bundle.id, now)
        .unwrap();
    assert_eq!(reshuffled, prepared);
    // Rebuilding the cache cannot invent an alternative when all 12 are shown.
    library.color_cache().entries.clear();
    let unchanged = library
        .reshuffle_revisit_bundle(date, &reshuffled.bundles[0].id, now)
        .unwrap();
    assert_eq!(unchanged, reshuffled);
    assert!(!library.color_cache().entries.is_empty());
    library.color_cache().entries.clear();
    for _ in 0..5 {
        library
            .set_revisit_preference("recommendation_type", "color", now)
            .unwrap();
    }
    let base = library.reshuffle_revisit_slate(date, now).unwrap();
    assert!(library
        .prepare_revisit_color_bundle(date, now, base.revision)
        .unwrap()
        .is_none());
    assert!(library.color_cache().entries.is_empty());
}

#[test]
fn color_shuffle_replaces_members_and_recovers_after_restart() {
    let (_temp, library) = fixture(24);
    let date = "2026-09-12";
    let now = "2026-09-12T10:00:00Z";
    let base = library.get_or_create_revisit_slate(date, now).unwrap();
    let mut slate = library
        .prepare_revisit_color_bundle(date, now, base.revision)
        .unwrap()
        .unwrap();
    for restart in [false, true] {
        if restart {
            *library.color_cache() = ColorCache::default();
        }
        let previous = &slate.bundles[0];
        let next = library
            .reshuffle_revisit_bundle(date, &previous.id, now)
            .unwrap();
        assert_eq!(next.bundles[0].asset_ids.len(), 12);
        assert!(
            next.bundles[0]
                .asset_ids
                .iter()
                .all(|id| !previous.asset_ids.contains(id)),
            "an equally close alternative group should replace the old members (restart={restart})"
        );
        slate = next;
    }
}

#[test]
fn stale_preparation_busy_requests_and_changed_sources_cannot_publish() {
    let (_temp, library) = fixture(4);
    let date = "2026-09-12";
    let now = "2026-09-12T10:00:00Z";
    let base = library.get_or_create_revisit_slate(date, now).unwrap();
    {
        let _worker = library.revisit_color_lock.lock().unwrap();
        assert!(library
            .prepare_revisit_color_bundle(date, now, base.revision)
            .unwrap()
            .is_none());
    }
    library.prepare_color_candidates(Instant::now()).unwrap();
    let colors = library.current_colors().unwrap();
    let newer = library.reshuffle_revisit_slate(date, now).unwrap();
    let connection = library.connection().unwrap();
    assert!(super::super::revisit::append_color_bundle(
        &connection,
        date,
        now,
        base.revision,
        &colors
    )
    .unwrap()
    .is_none());
    connection
        .execute(
            "UPDATE assets SET status='trash' WHERE id IN ('asset-0000','asset-0001')",
            [],
        )
        .unwrap();
    assert!(super::super::revisit::append_color_bundle(
        &connection,
        date,
        now,
        newer.revision,
        &colors
    )
    .unwrap()
    .is_none());
    assert_eq!(
        super::super::revisit::load_daily_slate(&connection, date)
            .unwrap()
            .unwrap(),
        newer
    );
}

#[test]
fn weak_palette_matches_do_not_fill_a_color_bundle() {
    let (temp, library) = fixture(3);
    pattern(&[[20, 60, 240, 255], [10, 30, 120, 255]], 32)
        .save(temp.path().join("thumbnails/asset-0002.png"))
        .unwrap();
    let base = library
        .get_or_create_revisit_slate("2026-09-12", "2026-09-12T10:00:00Z")
        .unwrap();
    assert!(library
        .prepare_revisit_color_bundle(&base.local_date, &base.created_at, base.revision)
        .unwrap()
        .is_none());
}

#[test]
fn preparation_fixture_costs() {
    let (_temp, library) = fixture(64);
    let base_started = Instant::now();
    library
        .get_or_create_revisit_slate("2026-09-12", "2026-09-12T10:00:00Z")
        .unwrap();
    let base_elapsed = base_started.elapsed();
    let cold_started = Instant::now();
    let cold = library.prepare_color_candidates(cold_started).unwrap();
    let cold_elapsed = cold_started.elapsed();
    library.color_cache().cursors = [None, None];
    let warm_started = Instant::now();
    let warm = library.prepare_color_candidates(warm_started).unwrap();
    let warm_elapsed = warm_started.elapsed();
    let cache = library.color_cache();
    let descriptor_bytes = cache.entries.len() * std::mem::size_of::<ColorSignature>();
    let entry_bytes: usize = cache
        .entries
        .values()
        .map(|entry| {
            std::mem::size_of::<CacheEntry>()
                + entry.source.id.capacity()
                + entry.source.hash.capacity()
                + entry.source.collected_at.capacity()
                + entry.source.thumbnail.as_ref().map_or(0, String::capacity)
        })
        .sum();
    eprintln!("revisit fixture64 base={base_elapsed:?} cold={cold_elapsed:?} reads={} decodes={} warm={warm_elapsed:?} reads={} decodes={} entries={} descriptors={descriptor_bytes}B entry_payload={entry_bytes}B (excludes map/allocator overhead)", cold.reads, cold.decodes, warm.reads, warm.decodes, cache.entries.len());
    assert!(cold.decodes <= MAX_FILES);
    assert_eq!(warm.decodes, 0);
    assert_eq!(warm.reads, 0);
}

#[test]
fn appending_color_preserves_base_cards_without_duplicate_assets() {
    let (_temp, library) = fixture(60);
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET creator_handle='artist', collected_at='2025-09-01T00:00:00Z'",
            [],
        )
        .unwrap();
    let base = library
        .get_or_create_revisit_slate("2026-09-12", "2026-09-12T10:00:00Z")
        .unwrap();
    assert_eq!(base.bundles.len(), 2);
    let next = library
        .prepare_revisit_color_bundle(&base.local_date, &base.created_at, base.revision)
        .unwrap()
        .unwrap();
    assert_eq!(next.bundles.len(), 3);
    assert_eq!(next.bundles[..2], base.bundles);
    let ids: Vec<_> = next
        .bundles
        .iter()
        .flat_map(|bundle| bundle.asset_ids.iter())
        .collect();
    assert_eq!(ids.len(), ids.iter().collect::<BTreeSet<_>>().len());
}

#[cfg(unix)]
#[test]
fn thumbnail_symlink_outside_library_is_never_read() {
    let (temp, library) = fixture(1);
    let outside = tempfile::NamedTempFile::new().unwrap();
    let path = temp.path().join("thumbnails/asset-0000.png");
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(outside.path(), &path).unwrap();
    let stats = library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(stats.reads, 0);
    assert!(library.current_colors().unwrap().is_empty());
}

#[test]
fn exhausted_preparation_budget_preserves_verified_candidates_for_publication() {
    let (temp, library) = fixture(6);
    let date = "2026-09-12";
    let now = "2026-09-12T10:00:00Z";
    let base = library.get_or_create_revisit_slate(date, now).unwrap();
    library.prepare_color_candidates(Instant::now()).unwrap();
    assert_eq!(library.color_cache().entries.len(), 6);

    // A used-up decode budget must not bypass source safety or discard the
    // remaining good candidates. These changes require metadata checks only.
    std::fs::remove_file(temp.path().join("thumbnails/asset-0000.png")).unwrap();
    {
        let connection = library.connection().unwrap();
        connection
            .execute("UPDATE assets SET status='trash' WHERE id='asset-0001'", [])
            .unwrap();
        connection
            .execute(
                "UPDATE assets SET content_hash='changed-source' WHERE id='asset-0002'",
                [],
            )
            .unwrap();
    }
    let expired = Instant::now() - PREPARATION_BUDGET - Duration::from_millis(1);
    let stats = library.prepare_color_candidates(expired).unwrap();
    assert_eq!(stats.reads, 0);
    assert_eq!(stats.decodes, 0);

    let colors = library.current_colors().unwrap();
    assert_eq!(
        colors.len(),
        3,
        "already prepared valid candidates survive the decode deadline"
    );
    let connection = library.connection().unwrap();
    let published =
        super::super::revisit::append_color_bundle(&connection, date, now, base.revision, &colors)
            .unwrap()
            .unwrap();
    assert_eq!(published.bundles[0].asset_ids.len(), 3);
    assert!(published.bundles[0].asset_ids.iter().all(|id| [
        "asset-0003",
        "asset-0004",
        "asset-0005"
    ]
    .contains(&id.as_str())));
}
