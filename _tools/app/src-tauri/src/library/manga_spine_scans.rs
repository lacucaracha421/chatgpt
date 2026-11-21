//! Library-local, disposable bookstore scans. No Collection authority writes.
use super::{error::LibraryError, Library};
use image::ImageDecoder;
use rusqlite::params;
#[cfg(test)]
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Write},
    path::PathBuf,
};

pub(crate) const DUE_SQL: &str = "SELECT DISTINCT s.isbn13
    FROM collection_volume_sources s
    JOIN collection_volumes v ON v.collection_id=s.collection_id AND v.volume_number=s.volume_number
    JOIN collections c ON c.id=s.collection_id
    LEFT JOIN manga_spine_scans scan ON scan.isbn13=s.isbn13
    WHERE c.type='manga' AND length(s.isbn13)=13 AND s.isbn13 NOT GLOB '*[^0-9]*'
    AND (scan.isbn13 IS NULL OR (scan.status IN ('missing','not_found') AND scan.checked_at<=?1-2592000)
         OR (scan.status='error' AND scan.checked_at<=?1-86400)
         OR (scan.status<>'error' AND (scan.aladin_checked_at IS NULL
             OR (scan.side_source IS NOT 'aladin' AND scan.aladin_checked_at<=?1-2592000))))
    ORDER BY s.isbn13";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpineScan {
    pub side: Option<String>,
    pub back: Option<String>,
}

pub(crate) fn valid_isbn(isbn: &str) -> bool {
    isbn.len() == 13 && isbn.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn goods_id(html: &str) -> Option<&str> {
    html.match_indices("goods/").find_map(|(offset, _)| {
        let rest = &html[offset + 6..];
        let end = rest.bytes().take_while(u8::is_ascii_digit).count();
        (end > 0).then_some(&rest[..end])
    })
}

/// The first Aladin search result link; banner links carry the same `wproduct.aspx` path
/// but never `class="bo3"`.
pub(crate) fn aladin_item_id(html: &str) -> Option<&str> {
    const LINK: &str = "wproduct.aspx?ItemId=";
    html.match_indices(LINK).find_map(|(offset, _)| {
        let rest = &html[offset + LINK.len()..];
        let end = rest.bytes().take_while(u8::is_ascii_digit).count();
        (end > 0 && rest[end..].starts_with("\" class=\"bo3\"")).then_some(&rest[..end])
    })
}

/// Aladin answers HTTP 200 with an HTML page when a book has no spine, so only a JPEG that is
/// taller than wide counts.
pub(crate) fn aladin_spine_jpeg(bytes: &[u8]) -> bool {
    image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes))
        .is_ok_and(|decoder| decoder.dimensions().1 > decoder.dimensions().0)
}

/// Read the JPEG header only; YES24's HTTP-200 placeholder has this exact size.
pub(crate) fn real_jpeg(bytes: &[u8]) -> Result<bool, ()> {
    let decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).map_err(|_| ())?;
    Ok(decoder.dimensions() != (420, 600))
}

impl Library {
    pub(crate) fn same_runtime(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.lease, &other.lease)
    }

    pub(crate) fn due_spine_isbns(&self, now: i64) -> Result<Vec<String>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(DUE_SQL)?;
        let result = statement
            .query_map([now], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub(crate) fn spine_scan_path(&self, isbn: &str, part: &str) -> Option<PathBuf> {
        (valid_isbn(isbn) && matches!(part, "side" | "back")).then(|| {
            self.root()
                .join("manga-spine-scans")
                .join(format!("{isbn}-{part}.jpg"))
        })
    }

    #[cfg(test)]
    pub(crate) fn spine_scan(&self, isbn: &str) -> Result<Option<SpineScan>, LibraryError> {
        if !valid_isbn(isbn) {
            return Ok(None);
        }
        let parts = self
            .connection()?
            .query_row(
                "SELECT side,back,checked_at FROM manga_spine_scans WHERE isbn13=?1",
                [isbn],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((side, back, revision)) = parts else {
            return Ok(None);
        };
        Ok(self.spine_scan_parts(isbn, side, back, revision))
    }

    /// The PC URLs carry the scan's `checked_at` as a revision so a replaced image is not
    /// served from the WebView cache; the tablet's scan ids come from the server instead.
    pub(crate) fn spine_scan_parts(
        &self,
        isbn: &str,
        side: bool,
        back: bool,
        revision: i64,
    ) -> Option<SpineScan> {
        let url = |part: &str, exists: bool| {
            (exists
                && self
                    .spine_scan_path(isbn, part)
                    .is_some_and(|path| path.is_file()))
            .then(|| format!("manga-spine-scan/{isbn}/{part}/v{revision}"))
        };
        let scan = SpineScan {
            side: url("side", side),
            back: url("back", back),
        };
        (scan.side.is_some() || scan.back.is_some()).then_some(scan)
    }

    pub(crate) fn save_spine_status(
        &self,
        isbn: &str,
        status: &str,
        side: bool,
        back: bool,
        now: i64,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "INSERT INTO manga_spine_scans(isbn13,status,side,back,checked_at)
            VALUES (?1,?2,?3,?4,?5) ON CONFLICT(isbn13) DO UPDATE SET status=excluded.status,
            side=excluded.side,back=excluded.back,checked_at=excluded.checked_at,
            side_source=CASE WHEN excluded.side=1 THEN side_source END",
            params![isbn, status, side, back, now],
        )?;
        Ok(())
    }

    /// Call after `save_spine_status` for the same ISBN. `None` keeps what is already stored.
    pub(crate) fn save_spine_sources(
        &self,
        isbn: &str,
        side_source: Option<&str>,
        aladin_checked_at: Option<i64>,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE manga_spine_scans SET side_source=COALESCE(?2,side_source),
            aladin_checked_at=COALESCE(?3,aladin_checked_at) WHERE isbn13=?1",
            params![isbn, side_source, aladin_checked_at],
        )?;
        Ok(())
    }

    pub(crate) fn save_spine_bytes(
        &self,
        isbn: &str,
        part: &str,
        bytes: &[u8],
    ) -> std::io::Result<()> {
        let path = self
            .spine_scan_path(isbn, part)
            .ok_or(std::io::ErrorKind::InvalidInput)?;
        let directory = path.parent().unwrap();
        std::fs::create_dir_all(directory)?;
        let mut temp = tempfile::NamedTempFile::new_in(directory)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(&path).map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod manga_spine_tests {
    use super::*;
    pub(crate) const PLACEHOLDER: &[u8] = include_bytes!("fixtures/yes24-placeholder.jpg");
    pub(crate) const SIDE: &[u8] = include_bytes!("fixtures/yes24-side.jpg");

    #[test]
    fn first_goods_match_and_exact_placeholder_dimensions() {
        assert_eq!(
            goods_id("goods/no <a href='/goods/12345'>goods/6789</a>"),
            Some("12345")
        );
        assert_eq!(goods_id("no books here"), None);
        assert_eq!(real_jpeg(PLACEHOLDER), Ok(false));
        assert_eq!(real_jpeg(SIDE), Ok(true));
        assert_eq!(real_jpeg(b"not a JPEG"), Err(()));
        assert!(!valid_isbn("../12345678901"));
    }

    #[test]
    fn aladin_item_id_is_the_search_result_never_a_banner() {
        let page = "<a href=\"wproduct.aspx?ItemId=406522102\" class=\"banner\">
            <a href=\"/shop/wproduct.aspx?ItemId=123456\" class=\"cover_area\">
            <a href=\"/shop/wproduct.aspx?ItemId=123456\" class=\"bo3\"><b>title</b></a>
            <a href=\"/shop/wproduct.aspx?ItemId=999\" class=\"bo3\">";
        assert_eq!(aladin_item_id(page), Some("123456"));
        assert_eq!(
            aladin_item_id("<a href=\"wproduct.aspx?ItemId=406522102\" class=\"banner\">"),
            None
        );
        assert_eq!(aladin_item_id("no results"), None);
    }

    #[test]
    fn aladin_spine_must_be_a_jpeg_taller_than_wide() {
        assert!(aladin_spine_jpeg(SIDE));
        assert!(!aladin_spine_jpeg(b"<html>no spine</html>"));
        let mut wide = Vec::new();
        image::DynamicImage::new_rgb8(20, 10)
            .write_to(&mut Cursor::new(&mut wide), image::ImageFormat::Jpeg)
            .unwrap();
        assert!(!aladin_spine_jpeg(&wide));
    }

    #[test]
    fn migration_marks_existing_sides_as_yes24_and_asks_aladin_for_every_row() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../migrations/0139_manga_spine_scans.sql"))
            .unwrap();
        db.execute_batch(
            "INSERT INTO manga_spine_scans VALUES ('9780000000001','real',1,0,5),
             ('9780000000002','real',0,1,5);",
        )
        .unwrap();
        db.execute_batch(include_str!(
            "../../migrations/0142_manga_spine_sources.sql"
        ))
        .unwrap();
        let rows: Vec<(Option<String>, Option<i64>)> = db
            .prepare("SELECT side_source,aladin_checked_at FROM manga_spine_scans ORDER BY isbn13")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, [(Some("yes24".into()), None), (None, None)]);
    }

    #[test]
    fn due_isbns_are_distinct_manga_only_and_honor_retry_deadlines() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE collections(id TEXT,type TEXT);
            CREATE TABLE collection_volumes(collection_id TEXT,volume_number INTEGER);
            CREATE TABLE collection_volume_sources(collection_id TEXT,volume_number INTEGER,isbn13 TEXT);").unwrap();
        db.execute_batch(include_str!("../../migrations/0139_manga_spine_scans.sql"))
            .unwrap();
        db.execute_batch(include_str!(
            "../../migrations/0142_manga_spine_sources.sql"
        ))
        .unwrap();
        db.execute(
            "INSERT INTO collections VALUES ('m','manga'),('g','game')",
            [],
        )
        .unwrap();
        let now = 4_000_000;
        let month = 2592000;
        // (volume, status, age of the check, Aladin asked this long ago, side source, due)
        for (number, status, age, asked, source, due) in [
            (1, "missing", month, Some(0), None, true),
            (2, "not_found", month - 1, Some(0), None, false),
            (3, "error", 86400, Some(0), None, true),
            // An error waits for its own one-day retry even though Aladin was never asked.
            (4, "error", 86399, None, None, false),
            (5, "real", 3000000, Some(0), Some("yes24"), false),
            // Existing rows from before the update get one Aladin pass.
            (6, "real", 0, None, Some("yes24"), true),
            (7, "real", 0, Some(month), Some("yes24"), true),
            (8, "real", 0, Some(month), Some("aladin"), false),
            (9, "real", 0, Some(month - 1), None, false),
        ] {
            db.execute("INSERT INTO collection_volumes VALUES ('m',?1)", [number])
                .unwrap();
            let isbn = format!("978000000000{number}");
            db.execute(
                "INSERT INTO collection_volume_sources VALUES ('m',?1,?2)",
                params![number, isbn],
            )
            .unwrap();
            db.execute(
                "INSERT INTO manga_spine_scans(isbn13,status,side,back,checked_at,side_source,aladin_checked_at)
                 VALUES (?1,?2,0,0,?3,?4,?5)",
                params![isbn, status, now - age, source, asked.map(|ago| now - ago)],
            )
            .unwrap();
            let mut stmt = db.prepare(DUE_SQL).unwrap();
            let values = stmt
                .query_map([now], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(values.contains(&isbn), due, "volume {number}");
        }
        db.execute_batch("INSERT INTO collection_volumes VALUES ('g',1),('m',10);
            INSERT INTO collection_volume_sources VALUES ('g',1,'9780000000011'),('m',10,'9780000000010'),('m',10,'9780000000010'),('m',10,'invalid');").unwrap();
        let mut stmt = db.prepare(DUE_SQL).unwrap();
        let values = stmt
            .query_map([now], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            values,
            [
                "9780000000001",
                "9780000000003",
                "9780000000006",
                "9780000000007",
                "9780000000010"
            ]
        );
    }
}
