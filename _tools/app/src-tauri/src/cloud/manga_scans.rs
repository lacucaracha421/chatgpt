//! Bounded derived-image publication on the existing background publisher loop.
use crate::library::{credential, error::LibraryError, Library};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::io::Read;

const PENDING: &str = "SELECT s.isbn13,parts.part,s.checked_at FROM manga_spine_scans s
 JOIN (SELECT 'side' part UNION ALL SELECT 'back') parts
 LEFT JOIN manga_scan_publications p ON p.endpoint=?1 AND p.isbn13=s.isbn13 AND p.part=parts.part
 WHERE ((parts.part='side' AND s.side=1) OR (parts.part='back' AND s.back=1))
 AND (p.source_checked_at IS NULL OR p.source_checked_at<>s.checked_at)
 AND COALESCE(p.retry_after,0)<=?2 ORDER BY s.isbn13,parts.part LIMIT 4";

pub(crate) fn pending(
    db: &Connection,
    endpoint: &str,
    now: i64,
) -> Result<Vec<(String, String, i64)>, LibraryError> {
    let mut statement = db.prepare(PENDING)?;
    let rows = statement
        .query_map(params![endpoint, now], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
impl Library {
    pub(crate) fn publish_pending_manga_scans(&self, endpoint: &str) -> Result<(), LibraryError> {
        if crate::workload::is_lightweight() || crate::workload::is_restricted() {
            return Ok(());
        }
        self.ensure_send_to(endpoint)?;
        let now = chrono::Utc::now().timestamp();
        let rows = pending(&*self.connection()?, endpoint, now)?;
        if rows.is_empty() {
            return Ok(());
        }
        let token = credential::read_cloud_publisher_token_os()?;
        let client = self.cloud_client(endpoint)?;
        for (isbn, part, checked) in rows {
            std::thread::sleep(std::time::Duration::from_secs(1));
            self.ensure_send_to(endpoint)?;
            let result = (|| {
                let path = self
                    .spine_scan_path(&isbn, &part)
                    .ok_or(LibraryError::InvalidCloudResponse)?;
                let mut bytes = Vec::new();
                std::fs::File::open(path)
                    .map_err(|_| LibraryError::InvalidCloudResponse)?
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| LibraryError::InvalidCloudResponse)?;
                if bytes.is_empty() || bytes.len() > 2 * 1024 * 1024 {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                let digest: String = Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                client.upload_manga_scan(&isbn, &part, &digest, &bytes, &token.expose())?;
                Ok(digest)
            })();
            match result {
                Ok(digest) => {
                    self.connection()?.execute("INSERT INTO manga_scan_publications(endpoint,isbn13,part,source_checked_at,sha256) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(endpoint,isbn13,part) DO UPDATE SET source_checked_at=excluded.source_checked_at,sha256=excluded.sha256,retry_after=0",params![endpoint,isbn,part,checked,digest])?;
                }
                Err(error) => {
                    self.connection()?.execute("INSERT INTO manga_scan_publications(endpoint,isbn13,part,retry_after) VALUES(?1,?2,?3,?4) ON CONFLICT(endpoint,isbn13,part) DO UPDATE SET retry_after=excluded.retry_after",params![endpoint,isbn,part,chrono::Utc::now().timestamp()+300])?;
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manga_scan_publication_resumes_and_retries_per_endpoint_and_part() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../migrations/0139_manga_spine_scans.sql"))
            .unwrap();
        db.execute_batch(include_str!(
            "../../migrations/0140_manga_scan_publications.sql"
        ))
        .unwrap();
        db.execute_batch("INSERT INTO manga_spine_scans VALUES('9780306406157','real',1,1,10);")
            .unwrap();
        assert_eq!(pending(&db, "server", 100).unwrap().len(), 2);
        db.execute_batch("INSERT INTO manga_scan_publications VALUES('server','9780306406157','side',10,'digest',0);").unwrap();
        assert_eq!(pending(&db, "server", 100).unwrap()[0].1, "back");
        db.execute_batch("INSERT INTO manga_scan_publications VALUES('server','9780306406157','back',-1,NULL,200);").unwrap();
        assert!(pending(&db, "server", 199).unwrap().is_empty());
        assert_eq!(pending(&db, "server", 200).unwrap().len(), 1);
        assert_eq!(pending(&db, "other", 100).unwrap().len(), 2);
        db.execute_batch("UPDATE manga_spine_scans SET checked_at=11;")
            .unwrap();
        assert_eq!(pending(&db, "server", 200).unwrap().len(), 2);
    }
}
