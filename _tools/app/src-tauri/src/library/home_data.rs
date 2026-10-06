use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde::Serialize;

use super::{
    av_models::{AvError, AvPortrait},
    error::LibraryError,
    Library,
};

#[derive(Debug, thiserror::Error)]
pub(crate) enum HomeDataError {
    #[error("AV 배우를 찾을 수 없습니다.")]
    InvalidAvPerformer,
    #[error(transparent)]
    Library(#[from] LibraryError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Av(#[from] AvError),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvFavorite {
    pub id: String,
    pub display_name: String,
    pub original_name: Option<String>,
    pub portrait: Option<AvPortrait>,
    pub owned_work_count: i64,
    pub recent_owned_count: i64,
    pub created_at: String,
}

impl Library {
    pub(crate) fn set_av_favorite(
        &self,
        person_id: &str,
        favorite: bool,
    ) -> Result<(), HomeDataError> {
        let connection = self.connection()?;
        // Favorites are shared person data without an authority command yet (1B §4).
        super::collection_authority::fence_collection_operation(&connection)?;
        if favorite {
            let performer: bool = connection.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM collection_person_relations r
                   JOIN collections c ON c.id=r.collection_id AND c.type='av'
                   WHERE r.person_id=?1 AND r.role='performer'
                 )",
                [person_id],
                |row| row.get(0),
            )?;
            if !performer {
                return Err(HomeDataError::InvalidAvPerformer);
            }
            connection.execute(
                "INSERT INTO av_favorite_performers(person_id,created_at) VALUES(?1,?2)
                 ON CONFLICT(person_id) DO NOTHING",
                params![person_id, Utc::now().to_rfc3339()],
            )?;
        } else {
            connection.execute(
                "DELETE FROM av_favorite_performers WHERE person_id=?1",
                [person_id],
            )?;
        }
        Ok(())
    }

    pub(crate) fn list_av_favorites(&self) -> Result<Vec<AvFavorite>, HomeDataError> {
        self.list_av_favorites_since(Utc::now() - Duration::days(30))
    }

    fn list_av_favorites_since(
        &self,
        recent_cutoff: DateTime<Utc>,
    ) -> Result<Vec<AvFavorite>, HomeDataError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT f.person_id,p.display_name,NULLIF(TRIM(p.name_ja),''),
                    COUNT(DISTINCT c.id),
                    COUNT(DISTINCT CASE WHEN julianday(c.created_at)>=julianday(?1) THEN c.id END),
                    f.created_at
             FROM av_favorite_performers f
             JOIN collection_people p ON p.id=f.person_id
             LEFT JOIN collection_person_relations r ON r.person_id=p.id AND r.role='performer'
             LEFT JOIN collections c ON c.id=r.collection_id AND c.type='av'
             GROUP BY f.person_id,p.display_name,p.name_ja,f.created_at
             ORDER BY f.created_at DESC,f.person_id",
        )?;
        let mut favorites = statement
            .query_map([recent_cutoff.to_rfc3339()], |row| {
                Ok(AvFavorite {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    original_name: row.get(2)?,
                    portrait: None,
                    owned_work_count: row.get(3)?,
                    recent_owned_count: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for favorite in &mut favorites {
            favorite.original_name = favorite
                .original_name
                .take()
                .filter(|name| name != &favorite.display_name);
            favorite.portrait = super::av_portrait::portrait(&connection, &favorite.id)?;
        }
        Ok(favorites)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, Library) {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        (root, library)
    }

    #[test]
    fn favorites_include_portrait_counts_and_creation_order() {
        let (_root, library) = library();
        let connection = library.connection().unwrap();
        connection.execute_batch(
            "INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES
               ('p1','Display','Original','t','t'),('p2','Same','Same','t','t');
             INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
               ('old','Old','av','2026-07-01T00:00:00Z','t'),
               ('new','New','av','2026-09-20T00:00:00Z','t'),
               ('new2','New 2','av','2026-09-21T00:00:00Z','t');
             INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES
               ('old','p1','performer',0),('new','p1','performer',0),('new2','p2','performer',0);
             INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at)
               VALUES('p1','commons',X'01','image/png',1,1,'portrait.png','https://commons.wikimedia.org/p','t');",
        ).unwrap();
        drop(connection);
        library.set_av_favorite("p1", true).unwrap();
        library.set_av_favorite("p2", true).unwrap();
        let connection = library.connection().unwrap();
        connection.execute("UPDATE av_favorite_performers SET created_at='2026-09-01T00:00:00Z' WHERE person_id='p1'", []).unwrap();
        connection.execute("UPDATE av_favorite_performers SET created_at='2026-09-02T00:00:00Z' WHERE person_id='p2'", []).unwrap();
        drop(connection);

        let favorites = library
            .list_av_favorites_since("2026-09-01T00:00:00Z".parse().unwrap())
            .unwrap();
        assert_eq!(
            favorites
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p2", "p1"]
        );
        assert_eq!(favorites[1].original_name.as_deref(), Some("Original"));
        assert_eq!(
            (
                favorites[1].owned_work_count,
                favorites[1].recent_owned_count
            ),
            (2, 1)
        );
        assert!(favorites[1].portrait.is_some());
        assert_eq!(favorites[0].original_name, None);

        let connection = library.connection().unwrap();
        connection
            .execute("DELETE FROM collections WHERE id IN ('old','new')", [])
            .unwrap();
        drop(connection);
        let empty_favorite = library
            .list_av_favorites_since("2026-09-01T00:00:00Z".parse().unwrap())
            .unwrap()
            .into_iter()
            .find(|item| item.id == "p1")
            .unwrap();
        assert_eq!(
            (
                empty_favorite.owned_work_count,
                empty_favorite.recent_owned_count
            ),
            (0, 0)
        );

        library.set_av_favorite("p1", false).unwrap();
        assert_eq!(
            library
                .list_av_favorites()
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p2"]
        );
    }
}
