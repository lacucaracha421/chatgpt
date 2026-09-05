use rusqlite::{params, Connection};

use super::{
    error::LibraryError,
    models::{CatalogBlockedTag, CatalogVisibilityPolicy},
    Library,
};

const HIDDEN_CATEGORY_PREDICATE: &str = "NOT EXISTS (
        SELECT 1 FROM main.online_catalog_hidden_categories AS hidden_category
        WHERE hidden_category.category = work.Category
    )";

const BLOCKED_TAG_PREDICATE: &str = "NOT EXISTS (
        SELECT 1
        FROM catalog.Tags AS blocked_work_tag
        JOIN main.online_catalog_blocked_tags AS blocked_tag
          ON blocked_tag.namespace = blocked_work_tag.Namespace
         AND blocked_tag.value = blocked_work_tag.Value
        WHERE blocked_work_tag.WorkId = work.Id
    )";

pub(crate) fn append_visibility_predicates(
    connection: &Connection,
    clauses: &mut Vec<String>,
) -> Result<(), LibraryError> {
    // Read once on the search connection while Library's database lock is held.
    // Empty policies otherwise still cause per-work probes into catalog.Tags.
    let (has_hidden_categories, has_blocked_tags): (bool, bool) = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.online_catalog_hidden_categories),
                EXISTS(SELECT 1 FROM main.online_catalog_blocked_tags)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if has_hidden_categories {
        clauses.push(HIDDEN_CATEGORY_PREDICATE.into());
    }
    if has_blocked_tags {
        clauses.push(BLOCKED_TAG_PREDICATE.into());
    }
    Ok(())
}

impl Library {
    pub fn catalog_visibility_policy(&self) -> Result<CatalogVisibilityPolicy, LibraryError> {
        let connection = self.connection()?;
        let hidden_categories = {
            let mut statement = connection.prepare(
                "SELECT category FROM online_catalog_hidden_categories ORDER BY category",
            )?;
            let categories = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<i64>, _>>()?;
            categories
        };
        let blocked_tags = {
            let mut statement = connection.prepare(
                "SELECT namespace, value FROM online_catalog_blocked_tags
                 ORDER BY namespace, value",
            )?;
            let tags = statement
                .query_map([], |row| {
                    Ok(CatalogBlockedTag {
                        namespace: row.get(0)?,
                        value: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            tags
        };
        Ok(CatalogVisibilityPolicy {
            hidden_categories,
            blocked_tags,
        })
    }

    pub fn set_catalog_category_hidden(
        &self,
        category: i64,
        hidden: bool,
    ) -> Result<CatalogVisibilityPolicy, LibraryError> {
        if !(1..=11).contains(&category) {
            return Err(LibraryError::InvalidCatalogVisibilityPolicy);
        }
        let connection = self.connection()?;
        if hidden {
            connection.execute(
                "INSERT INTO online_catalog_hidden_categories (category, created_at)
                 VALUES (?1, ?2) ON CONFLICT(category) DO NOTHING",
                params![category, chrono::Utc::now().to_rfc3339()],
            )?;
        } else {
            connection.execute(
                "DELETE FROM online_catalog_hidden_categories WHERE category = ?1",
                [category],
            )?;
        }
        drop(connection);
        self.catalog_visibility_policy()
    }

    pub fn set_catalog_tag_blocked(
        &self,
        tag: CatalogBlockedTag,
        blocked: bool,
    ) -> Result<CatalogVisibilityPolicy, LibraryError> {
        let namespace = tag.namespace.trim();
        let value = tag.value.trim();
        if namespace.is_empty() || value.is_empty() {
            return Err(LibraryError::InvalidCatalogVisibilityPolicy);
        }
        let connection = self.connection()?;
        if blocked {
            connection.execute(
                "INSERT INTO online_catalog_blocked_tags (namespace, value, created_at)
                 VALUES (?1, ?2, ?3) ON CONFLICT(namespace, value) DO NOTHING",
                params![namespace, value, chrono::Utc::now().to_rfc3339()],
            )?;
        } else {
            connection.execute(
                "DELETE FROM online_catalog_blocked_tags
                 WHERE namespace = ?1 AND value = ?2",
                params![namespace, value],
            )?;
        }
        drop(connection);
        self.catalog_visibility_policy()
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::super::{models::CatalogBlockedTag, Library};

    #[test]
    fn visibility_preferences_are_exact_mutable_and_persistent() {
        let temp = tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        assert_eq!(
            library
                .catalog_visibility_policy()
                .unwrap()
                .hidden_categories,
            Vec::<i64>::new()
        );
        library.set_catalog_category_hidden(2, true).unwrap();
        library.set_catalog_category_hidden(7, true).unwrap();
        library.set_catalog_category_hidden(2, false).unwrap();
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "artist".into(),
                    value: "same-value".into(),
                },
                true,
            )
            .unwrap();
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "group".into(),
                    value: "same-value".into(),
                },
                true,
            )
            .unwrap();
        assert_eq!(
            library
                .catalog_visibility_policy()
                .unwrap()
                .blocked_tags
                .len(),
            2
        );
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "artist".into(),
                    value: "same-value".into(),
                },
                false,
            )
            .unwrap();
        drop(library);

        let reopened = Library::open(temp.path()).unwrap();
        assert_eq!(
            reopened
                .catalog_visibility_policy()
                .unwrap()
                .hidden_categories,
            vec![7]
        );
        assert_eq!(
            reopened.catalog_visibility_policy().unwrap().blocked_tags,
            vec![CatalogBlockedTag {
                namespace: "group".into(),
                value: "same-value".into(),
            }]
        );
    }

    #[test]
    fn visibility_preferences_reject_invalid_categories_and_empty_tags() {
        let temp = tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        assert!(library.set_catalog_category_hidden(0, true).is_err());
        assert!(library.set_catalog_category_hidden(12, true).is_err());
        assert!(library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "  ".into(),
                    value: "value".into(),
                },
                true,
            )
            .is_err());
        assert!(library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "artist".into(),
                    value: "".into(),
                },
                true,
            )
            .is_err());
    }
}
