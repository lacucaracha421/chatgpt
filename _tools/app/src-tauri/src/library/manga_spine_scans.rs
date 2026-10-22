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
         OR (scan.status='error' AND scan.checked_at<=?1-86400)) ORDER BY s.isbn13";

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
                "SELECT side,back FROM manga_spine_scans WHERE isbn13=?1",
                [isbn],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        let Some((side, back)) = parts else {
            return Ok(None);
        };
        Ok(self.spine_scan_parts(isbn, side, back))
    }

    pub(crate) fn spine_scan_parts(&self, isbn: &str, side: bool, back: bool) -> Option<SpineScan> {
        let url = |part: &str, exists: bool| {
            (exists
                && self
                    .spine_scan_path(isbn, part)
                    .is_some_and(|path| path.is_file()))
            .then(|| format!("manga-spine-scan/{isbn}/{part}"))
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
            side=excluded.side,back=excluded.back,checked_at=excluded.checked_at",
            params![isbn, status, side, back, now],
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
    fn due_isbns_are_distinct_manga_only_and_honor_retry_deadlines() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE collections(id TEXT,type TEXT);
            CREATE TABLE collection_volumes(collection_id TEXT,volume_number INTEGER);
            CREATE TABLE collection_volume_sources(collection_id TEXT,volume_number INTEGER,isbn13 TEXT);").unwrap();
        db.execute_batch(include_str!("../../migrations/0139_manga_spine_scans.sql"))
            .unwrap();
        db.execute(
            "INSERT INTO collections VALUES ('m','manga'),('g','game')",
            [],
        )
        .unwrap();
        let now = 4_000_000;
        for (number, status, age, due) in [
            (1, "missing", 2592000, true),
            (2, "not_found", 2591999, false),
            (3, "error", 86400, true),
            (4, "error", 86399, false),
            (5, "real", 3000000, false),
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
                "INSERT INTO manga_spine_scans VALUES (?1,?2,0,0,?3)",
                params![isbn, status, now - age],
            )
            .unwrap();
            let mut stmt = db.prepare(DUE_SQL).unwrap();
            let values = stmt
                .query_map([now], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(values.contains(&isbn), due);
        }
        db.execute_batch("INSERT INTO collection_volumes VALUES ('g',1),('m',6);
            INSERT INTO collection_volume_sources VALUES ('g',1,'9780000000007'),('m',6,'9780000000006'),('m',6,'9780000000006'),('m',6,'invalid');").unwrap();
        let mut stmt = db.prepare(DUE_SQL).unwrap();
        let values = stmt
            .query_map([now], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(values, ["9780000000001", "9780000000003", "9780000000006"]);
    }
}
