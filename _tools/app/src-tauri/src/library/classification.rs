use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::{
    character_autotag,
    classification_authority as authority,
    error::LibraryError,
    folder_appearance,
    models::{
        AssetClassificationPatch, ClassificationEntry, ClassificationKind, CreateClassification,
        SetAssetClassification,
    },
    validated_asset_ids, Library,
};

/// Enqueue the authoritative intent for an accepted local structural mutation.
///
/// Called after the local row is written, inside the same transaction, so a crash can
/// never leave a changed Classification with no queued intent nor an intent for a
/// Classification that never changed. When no authority is adopted this appends nothing
/// and the legacy PC-owned path is byte-identical to before.
///
/// Only a create introduces the Classification, so only a create omits the expectation;
/// every other structural command presents the revision the queue implies.
fn enqueue_structural(
    transaction: &Transaction<'_>,
    command_type: &str,
    classification_id: &str,
    fields: serde_json::Map<String, serde_json::Value>,
) -> Result<(), LibraryError> {
    let mut fields = fields;
    if command_type != authority::CREATE {
        let expected = authority::predicted_classification_revision(transaction, classification_id)?;
        fields.insert("expectedRevision".into(), expected.into());
    }
    Library::enqueue_classification_intent(transaction, command_type, classification_id, fields)
}

/// Whether this library has adopted the Classification authority.
///
/// Read on the caller's connection so the decision is made inside the same transaction
/// as the mutation it governs: consulting a second connection could observe a different
/// adoption state than the write it authorizes.
fn authority_adopted(connection: &Connection) -> Result<bool, LibraryError> {
    Ok(authority::read_authority(connection)?.is_some())
}

impl Library {
    pub fn create_classification(
        &self,
        request: CreateClassification,
    ) -> Result<ClassificationEntry, LibraryError> {
        let name = normalized_name(request.name)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let parent = find_parent(&transaction, request.parent_id.as_deref())?;
        validate_parent(&request.kind, parent.as_ref())?;

        let entry = ClassificationEntry {
            id: uuid::Uuid::new_v4().to_string(),
            kind: request.kind,
            name,
            parent_id: request.parent_id,
            icon_key: None,
            color_key: None,
            asset_count: 0,
            total_asset_count: None,
        };
        transaction
            .execute(
                "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    entry.id,
                    kind_name(&entry.kind),
                    entry.name,
                    entry.parent_id,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(map_duplicate_name)?;
        // The payload states every field the server's create contract requires, including
        // the ones this PC leaves unset on a new Classification: the contract rejects a
        // body whose key set disagrees with its declared command, so the values are
        // written explicitly rather than omitted as "absent".
        let mut fields = serde_json::Map::new();
        fields.insert("kind".into(), kind_name(&entry.kind).into());
        fields.insert("name".into(), entry.name.clone().into());
        fields.insert(
            "parentId".into(),
            match &entry.parent_id {
                Some(parent_id) => parent_id.clone().into(),
                None => serde_json::Value::Null,
            },
        );
        fields.insert(
            "iconKey".into(),
            match &entry.icon_key {
                Some(icon_key) => icon_key.clone().into(),
                None => serde_json::Value::Null,
            },
        );
        fields.insert(
            "colorKey".into(),
            match &entry.color_key {
                Some(color_key) => color_key.clone().into(),
                None => serde_json::Value::Null,
            },
        );
        enqueue_structural(&transaction, authority::CREATE, &entry.id, fields)?;
        transaction.commit()?;
        Ok(entry)
    }

    pub fn move_classification(
        &self,
        id: &str,
        parent_id: Option<&str>,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let entry =
            find_classification(&transaction, id)?.ok_or(LibraryError::ClassificationNotFound)?;
        if classification_has_role(&transaction, id, "originals")? {
            return Err(LibraryError::ProtectedClassification);
        }
        if let Some(parent_id) = parent_id {
            if classification_in_role_scope(&transaction, parent_id, "originals")?
                && classification_subtree_contains_character_series(&transaction, id)?
            {
                return Err(LibraryError::ProtectedClassification);
            }
        }
        let parent = find_parent(&transaction, parent_id)?;
        let next_kind = match (&entry.kind, parent.as_ref()) {
            (ClassificationKind::Root, Some(_)) => ClassificationKind::Tag,
            (ClassificationKind::Tag, None) => ClassificationKind::Root,
            _ => entry.kind.clone(),
        };
        validate_parent(&next_kind, parent.as_ref())?;

        if let Some(parent_id) = parent_id {
            let is_descendant: bool = transaction.query_row(
                "WITH RECURSIVE descendants(id) AS (
                     SELECT id FROM classification_entries WHERE id = ?1
                     UNION ALL
                     SELECT child.id
                     FROM classification_entries AS child
                     JOIN descendants ON child.parent_id = descendants.id
                 )
                 SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
                params![id, parent_id],
                |row| row.get(0),
            )?;
            if is_descendant {
                return Err(LibraryError::ClassificationCycle);
            }
        }

        transaction
            .execute(
                "UPDATE classification_entries SET kind = ?1, parent_id = ?2 WHERE id = ?3",
                params![kind_name(&next_kind), parent_id, id],
            )
            .map_err(map_duplicate_name)?;
        let mut fields = serde_json::Map::new();
        fields.insert(
            "parentId".into(),
            match parent_id {
                Some(parent_id) => parent_id.into(),
                None => serde_json::Value::Null,
            },
        );
        enqueue_structural(&transaction, authority::MOVE, id, fields)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn rename_classification(&self, id: &str, name: &str) -> Result<(), LibraryError> {
        let name = normalized_name(name.to_owned())?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // The protected node is refused before anything is written, so a rejected rename
        // leaves neither a local change nor a queued intent.
        if classification_has_role(&transaction, id, "originals")? {
            return Err(LibraryError::ProtectedClassification);
        }
        let changed = transaction
            .execute(
                "UPDATE classification_entries SET name = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(map_duplicate_name)?;
        if changed == 0 {
            return Err(LibraryError::ClassificationNotFound);
        }
        let mut fields = serde_json::Map::new();
        fields.insert("name".into(), name.into());
        enqueue_structural(&transaction, authority::RENAME, id, fields)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn update_classification_appearance(
        &self,
        id: &str,
        icon_key: Option<&str>,
        color_key: Option<&str>,
    ) -> Result<(), LibraryError> {
        if !folder_appearance::validate(icon_key, color_key) {
            return Err(LibraryError::InvalidClassificationAppearance);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE classification_entries
             SET icon_key = ?1, color_key = ?2
             WHERE id = ?3",
            params![icon_key, color_key, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::ClassificationNotFound);
        }
        let mut fields = serde_json::Map::new();
        fields.insert(
            "iconKey".into(),
            match icon_key {
                Some(icon_key) => icon_key.into(),
                None => serde_json::Value::Null,
            },
        );
        fields.insert(
            "colorKey".into(),
            match color_key {
                Some(color_key) => color_key.into(),
                None => serde_json::Value::Null,
            },
        );
        enqueue_structural(&transaction, authority::APPEARANCE, id, fields)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn classification_exists(&self, id: &str) -> Result<bool, LibraryError> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )?)
    }

    /// The folder tree for the app: direct counts plus subtree totals. The cloud
    /// classification snapshot reads `list_classifications_in` and keeps its payload.
    pub fn list_classifications(&self) -> Result<Vec<ClassificationEntry>, LibraryError> {
        let mut connection = self.connection()?;
        // One read transaction: the direct counts and the multi-link correction must see
        // the same snapshot, or a concurrent write could skew (or underflow) the totals.
        let transaction = connection.transaction()?;
        let mut entries = list_classifications_in(&transaction)?;
        apply_subtree_asset_counts(&transaction, &mut entries)?;
        transaction.commit()?;
        Ok(entries)
    }

    pub fn delete_classification(&self, id: &str) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let entry =
            find_classification(&transaction, id)?.ok_or(LibraryError::ClassificationNotFound)?;
        if classification_has_role(&transaction, id, "originals")? {
            return Err(LibraryError::ProtectedClassification);
        }
        let has_children: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE parent_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if has_children {
            return Err(LibraryError::ClassificationHasChildren);
        }

        let affected=transaction.prepare("SELECT asset_id FROM asset_classifications WHERE classification_id=?1")?
            .query_map([id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;

        if let Some(parent_id) = entry.parent_id {
            transaction.execute(
                "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id)
                 SELECT asset_id, ?2 FROM asset_classifications WHERE classification_id = ?1",
                params![id, parent_id],
            )?;
        }
        transaction.execute(
            "DELETE FROM asset_classifications WHERE classification_id = ?1",
            [id],
        )?;
        transaction.execute("DELETE FROM classification_entries WHERE id = ?1", [id])?;
        for asset_id in affected {
            character_autotag::enqueue(&transaction,&asset_id,character_autotag::Cause::Classification)?;
        }
        // Exactly **one** structural intent, with no expectation fields: the server's
        // delete command owns the whole effect atomically. It derives the transition
        // (`fromClassificationId` -> the deleted node's parent, or unassigned for a root)
        // and increments every affected assignment lineage itself, and it increments the
        // Classification's own revision. One assignment intent per affected Asset would
        // be a second, competing description of the same change, and could be split
        // across FIFO positions the server never agreed to.
        enqueue_structural(
            &transaction,
            authority::DELETE,
            id,
            serde_json::Map::new(),
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn patch_asset_classifications(
        &self,
        patch: AssetClassificationPatch,
    ) -> Result<(), LibraryError> {
        self.change_asset_classifications(
            &patch.asset_ids,
            &patch.add_classification_ids,
            &patch.remove_classification_ids,
        )
    }

    pub fn set_asset_classification(
        &self,
        request: SetAssetClassification,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        Self::set_asset_classification_in(&transaction, &request)?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn set_asset_classification_in(transaction: &rusqlite::Connection, request: &SetAssetClassification) -> Result<(), LibraryError> {
        Self::set_asset_classification_cause_in(transaction,request,super::character_autotag::Cause::Classification)
    }

    pub(super) fn set_asset_classification_cause_in(transaction: &Connection, request: &SetAssetClassification, cause: character_autotag::Cause) -> Result<(), LibraryError> {
        let asset_ids = validated_asset_ids(&transaction, &request.asset_ids)?;
        if let Some(classification_id) = request.classification_id.as_deref() {
            if find_classification(&transaction, classification_id)?.is_none() {
                return Err(LibraryError::ClassificationNotFound);
            }
        }
        // Read once, inside the transaction that will use it: consulting a second
        // connection could observe a different adoption state than the writes below.
        let managed = authority_adopted(transaction)?;
        for asset_id in asset_ids {
            let current=transaction.prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id")?
                .query_map([asset_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            if current == request.classification_id.iter().cloned().collect::<Vec<_>>() { continue; }
            transaction.execute(
                "DELETE FROM asset_classifications WHERE asset_id = ?1",
                [asset_id],
            )?;
            if let Some(classification_id) = request.classification_id.as_deref() {
                transaction.execute(
                    "INSERT INTO asset_classifications (asset_id, classification_id)
                     VALUES (?1, ?2)",
                    params![asset_id, classification_id],
                )?;
            }
            character_autotag::enqueue(transaction,asset_id,cause)?;
            if managed {
                // After adoption the Classification command owns this relation, so the
                // durable intent is the only thing queued. The legacy relation-only Asset
                // upsert is deliberately *not* created: it exists so the old replication
                // lane can carry `classification_ids`, and once the server owns
                // assignment that lane no longer writes them (2A.2 stops
                // `/v1/replication/commit` from touching `asset_classifications`). A
                // relation-only upsert would therefore re-upload Asset metadata, advance
                // the server's metadata revision, and converge nothing.
                //
                // Real Asset metadata/media replication is untouched: this branch is
                // reached only from this Classification mutation helper, and every other
                // Asset mutation still enqueues through its own path.
                Self::enqueue_classification_assignment_intent(
                    transaction,
                    asset_id,
                    request.classification_id.as_deref(),
                )?;
                continue;
            }
            // 관계-only 변경도 복제본에 전파되어야 한다. 증분 복제는 커밋 시
            // classification_ids를 다시 읽으므로, 다음 revision을 pending으로
            // 만들면 원본 미디어 재업로드 없이 관계가 수렴한다.
            //
            // A server-owned Asset is the exception: its canonical media already exists
            // on the server, so this lane has nothing to converge and an upsert would
            // re-upload media the server already has. The other enqueue paths refuse a
            // server-owned Asset too; this lane writes the queue directly, so it has to
            // carry the same rule rather than inheriting it from `enqueue_asset_upsert`.
            if crate::library::asset_authority::is_server_owned(transaction, asset_id)? {
                continue;
            }
            let next_revision: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(revision), 0) + 1 FROM cloud_sync_queue
                     WHERE entity_type = 'asset' AND entity_id = ?1
                       AND operation = 'upsert'",
                    [asset_id],
                    |row| row.get(0),
                )?;
            transaction.execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES (?1, 'asset', ?2, 'upsert', 'pending', ?3, ?4)
                 ON CONFLICT(entity_type, entity_id, operation, revision) DO NOTHING",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    asset_id,
                    next_revision,
                    chrono::Utc::now().to_rfc3339()
                ],
            )?;
        }
        Ok(())
    }

    pub fn get_asset_classifications(
        &self,
        asset_id: &str,
    ) -> Result<Vec<ClassificationEntry>, LibraryError> {
        let connection = self.connection()?;
        classifications_for_asset(&connection, asset_id)
    }
    /// Apply an add/remove Classification patch to many Assets.
    ///
    /// The patch is expressed as relation diffs, which is how the legacy PC-owned lane
    /// addresses several Classification relations at once. The Classification authority
    /// has no such contract: its invariant is single-valued
    /// (`asset_id -> classification_id | null`), so once adopted this computes the final
    /// effective value each Asset is left with and queues exactly one desired-state
    /// command per changed Asset. Encoding add/remove commands would invent a contract
    /// the authority does not have.
    fn change_asset_classifications(
        &self,
        asset_ids: &[String],
        add_ids: &[String],
        remove_ids: &[String],
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_ids = validated_asset_ids(&transaction, asset_ids)?;
        let add_ids: BTreeSet<_> = add_ids.iter().map(String::as_str).collect();
        let remove_ids: BTreeSet<_> = remove_ids.iter().map(String::as_str).collect();
        for classification_id in add_ids.iter().chain(remove_ids.iter()) {
            if find_classification(&transaction, classification_id)?.is_none() {
                return Err(LibraryError::ClassificationNotFound);
            }
        }
        let managed = authority_adopted(&transaction)?;
        for asset_id in asset_ids {
            let before=transaction.prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id")?
                .query_map([asset_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            for classification_id in &remove_ids {
                transaction.execute(
                    "DELETE FROM asset_classifications WHERE asset_id = ?1 AND classification_id = ?2",
                    params![asset_id, classification_id],
                )?;
            }
            for classification_id in &add_ids {
                transaction.execute(
                    "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                    params![asset_id, classification_id],
                )?;
            }
            let after=transaction.prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id")?
                .query_map([asset_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            if before == after {
                continue;
            }
            if managed {
                // The authority cannot represent more than one Classification per Asset,
                // so a patch that would leave several is refused *before* committing
                // rather than queued as state the contract has no command for. This can
                // only arise from pre-adoption N:N data or a patch that adds a second
                // Classification to an Asset that already holds one; the first adoption
                // comparison already refuses a divergent baseline, so reaching here means
                // the local caller asked for something the authority cannot hold.
                let desired = match after.as_slice() {
                    [] => None,
                    [single] => Some(single.as_str()),
                    _ => return Err(LibraryError::InvalidAssetSelection),
                };
                Self::enqueue_classification_assignment_intent(&transaction, asset_id, desired)?;
            }
            // Character reconsideration is owed for every changed Asset in both eras. The
            // receive half runs the same step for a change it applies, so skipping it here
            // would leave recognition inputs stale for exactly the edits the user made
            // locally — the case that most needs them fresh.
            character_autotag::enqueue(&transaction,asset_id,character_autotag::Cause::Classification)?;
        }
        transaction.commit()?;
        Ok(())
    }
}

/// One asset's Classifications with each entry's direct normal-asset count. The count
/// subquery starts from the entry's links (`asset_classifications_by_classification`) and
/// probes each asset by id: `CROSS JOIN` fixes that order. With a plain `JOIN` and no
/// `sqlite_stat1` the planner walks every normal asset per entry (PERF-ALL-001: 46 k VM
/// steps for one asset on the real library). `find_classification` and the similarity
/// review's `classifications_for_assets` use the same subquery.
/// Gate: `classification_counts_vm_steps_stay_proportional_to_links`.
const ASSET_CLASSIFICATIONS_SQL: &str =
    "SELECT entry.id, entry.kind, entry.name, entry.parent_id, entry.icon_key, entry.color_key,
        (SELECT COUNT(*) FROM asset_classifications AS count_link
         CROSS JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
         WHERE count_link.classification_id = entry.id
           AND count_asset.status = 'normal') AS asset_count
     FROM classification_entries AS entry
     JOIN asset_classifications AS link ON link.classification_id = entry.id
     WHERE link.asset_id = ?1
     ORDER BY entry.name COLLATE NOCASE, entry.id";

/// Links of normal assets that have more than one Classification, grouped by asset (the
/// subtree-total correction). The multi-linked assets (grouped on the link primary key)
/// drive the rest through `CROSS JOIN`; the earlier `IN (...)` form also walked every
/// normal asset (real library: 250 k -> 177 k VM steps, `list_classifications` ~7.6 ->
/// ~7.1 ms release). A self-join instead of `GROUP BY` costs fewer VM steps but scans the
/// link table b-tree cold and was slower. Row order within one asset is not significant.
const MULTI_LINKED_ASSETS_SQL: &str = "SELECT link.asset_id, link.classification_id
     FROM (
         SELECT asset_id FROM asset_classifications
         GROUP BY asset_id HAVING COUNT(*) > 1
     ) AS multi
     CROSS JOIN asset_classifications AS link ON link.asset_id = multi.asset_id
     CROSS JOIN assets AS asset ON asset.id = link.asset_id
     WHERE asset.status = 'normal'
     ORDER BY link.asset_id";

pub(crate) fn classifications_for_asset(
    connection: &Connection,
    asset_id: &str,
) -> Result<Vec<ClassificationEntry>, LibraryError> {
    let mut statement = connection.prepare(ASSET_CLASSIFICATIONS_SQL)?;
    read_entries(&mut statement, [asset_id])
}

fn normalized_name(name: String) -> Result<String, LibraryError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(LibraryError::EmptyClassificationName);
    }
    Ok(name)
}

fn find_parent(
    connection: &Connection,
    parent_id: Option<&str>,
) -> Result<Option<ClassificationEntry>, LibraryError> {
    parent_id
        .map(|parent_id| {
            find_classification(connection, parent_id)?.ok_or(LibraryError::ClassificationNotFound)
        })
        .transpose()
}

pub(crate) fn classification_in_role_scope(
    connection: &Connection,
    id: &str,
    role: &str,
) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        "WITH RECURSIVE lineage(id,parent_id) AS (
            SELECT id,parent_id FROM classification_entries WHERE id=?1
            UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN lineage p ON c.id=p.parent_id)
         SELECT EXISTS(SELECT 1 FROM lineage l JOIN classification_roles r ON r.classification_id=l.id WHERE r.role=?2)",
        params![id, role],
        |row| row.get(0),
    )?)
}

fn classification_subtree_contains_character_series(
    connection: &Connection,
    id: &str,
) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM classification_entries WHERE id=?1
            UNION ALL SELECT c.id FROM classification_entries c JOIN descendants d ON c.parent_id=d.id)
         SELECT EXISTS(SELECT 1 FROM character_series s JOIN descendants d ON d.id=s.classification_id)",
        [id],
        |row| row.get(0),
    )?)
}

fn classification_has_role(
    connection: &Connection,
    id: &str,
    role: &str,
) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM classification_roles WHERE role=?2 AND classification_id=?1)",
        params![id, role],
        |row| row.get(0),
    )?)
}

pub(crate) fn list_classifications_in(
    connection: &Connection,
) -> Result<Vec<ClassificationEntry>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT entry.id, entry.kind, entry.name, entry.parent_id, entry.icon_key, entry.color_key,
                COALESCE(counts.asset_count, 0) AS asset_count
         FROM classification_entries AS entry
         LEFT JOIN (
             SELECT link.classification_id, COUNT(*) AS asset_count
             FROM asset_classifications AS link
             JOIN assets AS asset ON asset.id = link.asset_id
             WHERE asset.status = 'normal'
             GROUP BY link.classification_id
         ) AS counts ON counts.classification_id = entry.id
         ORDER BY entry.parent_id, entry.name COLLATE NOCASE, entry.id",
    )?;
    read_entries(&mut statement, [])
}

/// Fills `total_asset_count`: distinct normal-status Assets in each entry and all its
/// descendants, matching what opening a folder shows by default (descendants included).
///
/// Summing the direct counts up the tree is exact for Assets linked once; the few Assets
/// linked to several entries are then corrected so each counts once per ancestor. This
/// avoids a recursive closure joined against every link, which is several times slower
/// on a large library, and the tree loads on every refresh.
fn apply_subtree_asset_counts(
    connection: &Connection,
    entries: &mut [ClassificationEntry],
) -> Result<(), LibraryError> {
    let index: std::collections::HashMap<String, usize> = entries
        .iter()
        .enumerate()
        .map(|(position, entry)| (entry.id.clone(), position))
        .collect();
    let parents: Vec<Option<usize>> = entries
        .iter()
        .map(|entry| {
            entry
                .parent_id
                .as_ref()
                .and_then(|id| index.get(id).copied())
        })
        .collect();
    // Self first, then each ancestor once; a corrupt parent cycle stops at a repeat.
    let lineage = |position: usize| {
        let mut chain = vec![position];
        let mut current = parents[position];
        while let Some(parent) = current {
            if chain.contains(&parent) {
                break;
            }
            chain.push(parent);
            current = parents[parent];
        }
        chain
    };
    let mut totals = vec![0u64; entries.len()];
    for (position, entry) in entries.iter().enumerate() {
        if entry.asset_count > 0 {
            for ancestor in lineage(position) {
                totals[ancestor] += entry.asset_count;
            }
        }
    }
    let mut statement = connection.prepare(MULTI_LINKED_ASSETS_SQL)?;
    let mut rows = statement.query([])?;
    let mut current_asset: Option<String> = None;
    let mut hits: std::collections::HashMap<usize, u64> = std::collections::HashMap::new();
    let mut settle = |hits: &mut std::collections::HashMap<usize, u64>| {
        for (ancestor, count) in hits.drain() {
            if count > 1 {
                totals[ancestor] = totals[ancestor].saturating_sub(count - 1);
            }
        }
    };
    while let Some(row) = rows.next()? {
        let asset_id: String = row.get(0)?;
        let classification_id: String = row.get(1)?;
        if current_asset.as_deref() != Some(asset_id.as_str()) {
            settle(&mut hits);
            current_asset = Some(asset_id);
        }
        if let Some(&position) = index.get(&classification_id) {
            for ancestor in lineage(position) {
                *hits.entry(ancestor).or_default() += 1;
            }
        }
    }
    settle(&mut hits);
    for (entry, total) in entries.iter_mut().zip(totals) {
        entry.total_asset_count = Some(total);
    }
    Ok(())
}

fn find_classification(
    connection: &Connection,
    id: &str,
) -> Result<Option<ClassificationEntry>, LibraryError> {
    let values = connection
        .query_row(
            "SELECT id, kind, name, parent_id, icon_key, color_key,
                (SELECT COUNT(*) FROM asset_classifications AS count_link
                 CROSS JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
                 WHERE count_link.classification_id = classification_entries.id
                   AND count_asset.status = 'normal') AS asset_count
             FROM classification_entries WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    values.map(entry_from_values).transpose()
}

fn read_entries<P>(
    statement: &mut rusqlite::Statement<'_>,
    parameters: P,
) -> Result<Vec<ClassificationEntry>, LibraryError>
where
    P: rusqlite::Params,
{
    let mut rows = statement.query(parameters)?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        entries.push(entry_from_values((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        ))?);
    }
    Ok(entries)
}

fn entry_from_values(
    (id, kind, name, parent_id, icon_key, color_key, asset_count): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    ),
) -> Result<ClassificationEntry, LibraryError> {
    let kind = match kind.as_str() {
        "root" => ClassificationKind::Root,
        "work" => ClassificationKind::Work,
        "tag" => ClassificationKind::Tag,
        _ => return Err(rusqlite::Error::InvalidQuery.into()),
    };
    Ok(ClassificationEntry {
        id,
        kind,
        name,
        parent_id,
        icon_key,
        color_key,
        asset_count: u64::try_from(asset_count).unwrap_or(0),
        total_asset_count: None,
    })
}

fn validate_parent(
    kind: &ClassificationKind,
    parent: Option<&ClassificationEntry>,
) -> Result<(), LibraryError> {
    let valid = match kind {
        ClassificationKind::Root => parent.is_none(),
        ClassificationKind::Work => matches!(
            parent,
            Some(ClassificationEntry {
                kind: ClassificationKind::Root,
                ..
            })
        ),
        ClassificationKind::Tag => parent.is_some(),
    };
    if valid {
        Ok(())
    } else {
        Err(LibraryError::InvalidClassificationParent)
    }
}

fn kind_name(kind: &ClassificationKind) -> &'static str {
    match kind {
        ClassificationKind::Root => "root",
        ClassificationKind::Work => "work",
        ClassificationKind::Tag => "tag",
    }
}

fn map_duplicate_name(error: rusqlite::Error) -> LibraryError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            LibraryError::DuplicateClassificationName
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::library::{
        error::LibraryError,
        models::{
            AssetClassificationPatch, ClassificationKind, CreateClassification,
            SetAssetClassification,
        },
        Library,
    };

    struct ClassificationFixture {
        _temp: TempDir,
        library: Library,
        root: crate::library::models::ClassificationEntry,
        parent_tag: crate::library::models::ClassificationEntry,
        child_tag: crate::library::models::ClassificationEntry,
    }

    impl ClassificationFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            let root = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Root,
                    name: "Games".into(),
                    parent_id: None,
                })
                .unwrap();
            let work = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Work,
                    name: "Blue Archive".into(),
                    parent_id: Some(root.id.clone()),
                })
                .unwrap();
            let parent_tag = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Tag,
                    name: "Student".into(),
                    parent_id: Some(work.id.clone()),
                })
                .unwrap();
            let child_tag = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Tag,
                    name: "Aru".into(),
                    parent_id: Some(parent_tag.id.clone()),
                })
                .unwrap();

            Self {
                _temp: temp,
                library,
                root,
                parent_tag,
                child_tag,
            }
        }
    }

    #[test]
    fn work_requires_a_root_parent_and_tag_can_nest_under_a_work() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        let work = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "Blue Archive".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let tag = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Aru".into(),
                parent_id: Some(work.id.clone()),
            })
            .unwrap();

        assert_eq!(tag.parent_id, Some(work.id));
    }

    #[test]
    fn moving_a_tag_below_its_descendant_is_rejected() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .move_classification(&fixture.parent_tag.id, Some(&fixture.child_tag.id))
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationCycle));
    }

    #[test]
    fn moving_a_tag_to_a_root_persists_its_new_parent() {
        let fixture = ClassificationFixture::new();

        fixture
            .library
            .move_classification(&fixture.child_tag.id, Some(&fixture.root.id))
            .unwrap();

        let moved = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(moved.parent_id, Some(fixture.root.id));
    }

    #[test]
    fn moving_a_root_below_another_root_demotes_it_without_moving_contents() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let destination = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        let moving = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Reverse".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Character".into(),
                parent_id: Some(moving.id.clone()),
            })
            .unwrap();
        insert_asset(&library, "asset-a");
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(moving.id.clone()),
            })
            .unwrap();

        library
            .move_classification(&moving.id, Some(&destination.id))
            .unwrap();

        let entries = library.list_classifications().unwrap();
        let moved = entries.iter().find(|entry| entry.id == moving.id).unwrap();
        let preserved_child = entries.iter().find(|entry| entry.id == child.id).unwrap();
        assert_eq!(moved.kind, ClassificationKind::Tag);
        assert_eq!(moved.parent_id, Some(destination.id));
        assert_eq!(preserved_child.parent_id, Some(moved.id.clone()));
        assert_eq!(moved.total_asset_count, Some(1));
        // Only the tree listing computes subtree totals; a per-Asset read leaves them unset.
        assert_eq!(
            library.get_asset_classifications("asset-a").unwrap(),
            vec![crate::library::models::ClassificationEntry {
                total_asset_count: None,
                ..moved.clone()
            }]
        );
    }

    #[test]
    fn moving_a_tag_to_the_top_level_promotes_it_without_moving_contents() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let destination = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        let moving = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Reverse".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Character".into(),
                parent_id: Some(moving.id.clone()),
            })
            .unwrap();
        insert_asset(&library, "asset-a");
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(moving.id.clone()),
            })
            .unwrap();
        library
            .move_classification(&moving.id, Some(&destination.id))
            .unwrap();

        library.move_classification(&moving.id, None).unwrap();

        let entries = library.list_classifications().unwrap();
        let moved = entries.iter().find(|entry| entry.id == moving.id).unwrap();
        let preserved_child = entries.iter().find(|entry| entry.id == child.id).unwrap();
        assert_eq!(moved.kind, ClassificationKind::Root);
        assert_eq!(moved.parent_id, None);
        assert_eq!(preserved_child.parent_id, Some(moved.id.clone()));
        assert_eq!(moved.total_asset_count, Some(1));
        // Only the tree listing computes subtree totals; a per-Asset read leaves them unset.
        assert_eq!(
            library.get_asset_classifications("asset-a").unwrap(),
            vec![crate::library::models::ClassificationEntry {
                total_asset_count: None,
                ..moved.clone()
            }]
        );
    }

    #[test]
    fn deleting_a_classification_with_children_is_rejected() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .delete_classification(&fixture.root.id)
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationHasChildren));
    }

    #[test]
    fn a_root_cannot_have_a_parent() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Comics".into(),
                parent_id: Some(fixture.root.id.clone()),
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidClassificationParent));
    }

    #[test]
    fn a_work_cannot_have_a_tag_parent() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "Arknights".into(),
                parent_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidClassificationParent));
    }

    #[test]
    fn a_tag_requires_a_parent() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let error = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Aru".into(),
                parent_id: None,
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidClassificationParent));
    }

    #[test]
    fn a_classification_name_cannot_be_blank() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let error = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: " \t ".into(),
                parent_id: None,
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::EmptyClassificationName));
    }

    #[test]
    fn deleting_a_leaf_moves_every_asset_state_to_its_parent_once() {
        let mut fixture = ClassificationFixture::new();
        for (id, status) in [
            ("asset-normal", "normal"),
            ("asset-review", "review"),
            ("asset-trash", "trash"),
        ] {
            insert_asset(&fixture.library, id);
            fixture
                .library
                .connection()
                .unwrap()
                .execute("UPDATE assets SET status = ?1 WHERE id = ?2", [status, id])
                .unwrap();
        }
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec![
                    "asset-normal".into(),
                    "asset-review".into(),
                    "asset-trash".into(),
                ],
                add_classification_ids: vec![fixture.child_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-normal".into()],
                add_classification_ids: vec![fixture.parent_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        fixture.parent_tag.asset_count = 1;

        fixture
            .library
            .delete_classification(&fixture.child_tag.id)
            .unwrap();

        for id in ["asset-normal", "asset-review", "asset-trash"] {
            assert_eq!(
                fixture.library.get_asset_classifications(id).unwrap(),
                vec![fixture.parent_tag.clone()],
            );
        }
        assert!(!fixture
            .library
            .list_classifications()
            .unwrap()
            .iter()
            .any(|entry| entry.id == fixture.child_tag.id));
    }

    #[test]
    fn deleting_an_asset_linked_root_preserves_the_asset_without_that_folder() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        insert_asset(&library, "asset-1");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-1".into()],
                add_classification_ids: vec![root.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        library.delete_classification(&root.id).unwrap();

        assert_eq!(library.get_asset("asset-1").unwrap().id, "asset-1");
        assert!(library
            .get_asset_classifications("asset-1")
            .unwrap()
            .is_empty());
        assert!(library
            .list_classifications()
            .unwrap()
            .iter()
            .all(|entry| entry.id != root.id));
    }

    #[test]
    fn deleting_an_empty_root_removes_it() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Unused".into(),
                parent_id: None,
            })
            .unwrap();

        library.delete_classification(&root.id).unwrap();

        assert!(library
            .list_classifications()
            .unwrap()
            .iter()
            .all(|entry| entry.id != root.id));
    }

    #[test]
    fn renaming_trims_the_name_and_rejects_a_duplicate_sibling() {
        let fixture = ClassificationFixture::new();

        fixture
            .library
            .rename_classification(&fixture.child_tag.id, "  Problem Solver  ")
            .unwrap();
        let renamed = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(renamed.name, "Problem Solver");

        fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Student".into(),
                parent_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap();

        let error = fixture
            .library
            .rename_classification(&fixture.child_tag.id, " Student ")
            .unwrap_err();
        assert!(matches!(error, LibraryError::DuplicateClassificationName));
    }

    #[test]
    fn classification_appearance_updates_and_resets() {
        let fixture = ClassificationFixture::new();

        fixture
            .library
            .update_classification_appearance(&fixture.child_tag.id, Some("photo"), Some("pink"))
            .unwrap();
        let changed = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(changed.icon_key.as_deref(), Some("photo"));
        assert_eq!(changed.color_key.as_deref(), Some("pink"));

        fixture
            .library
            .update_classification_appearance(&fixture.child_tag.id, None, None)
            .unwrap();
        let reset = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!((reset.icon_key, reset.color_key), (None, None));
    }

    #[test]
    fn classification_appearance_rejects_unknown_keys_without_changing_it() {
        let fixture = ClassificationFixture::new();

        assert!(matches!(
            fixture.library.update_classification_appearance(
                &fixture.child_tag.id,
                Some("uploaded-svg"),
                Some("#ffffff"),
            ),
            Err(LibraryError::InvalidClassificationAppearance)
        ));
        let entry = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!((entry.icon_key, entry.color_key), (None, None));
        assert!(matches!(
            fixture.library.update_classification_appearance(
                "missing-folder",
                Some("folder"),
                Some("blue"),
            ),
            Err(LibraryError::ClassificationNotFound)
        ));
    }

    #[test]
    fn list_classifications_returns_persisted_entries() {
        let fixture = ClassificationFixture::new();

        let entries = fixture.library.list_classifications().unwrap();
        let ids: Vec<_> = entries.into_iter().map(|entry| entry.id).collect();

        assert_eq!(ids.len(), 5);
        assert!(ids.contains(&fixture.root.id));
        assert!(ids.contains(&fixture.parent_tag.id));
        assert!(ids.contains(&fixture.child_tag.id));
    }

    #[test]
    fn list_classifications_counts_only_direct_normal_assets() {
        let fixture = ClassificationFixture::new();
        for (id, status) in [("asset-normal", "normal"), ("asset-trash", "trash")] {
            insert_asset(&fixture.library, id);
            fixture
                .library
                .connection()
                .unwrap()
                .execute("UPDATE assets SET status = ?1 WHERE id = ?2", [status, id])
                .unwrap();
        }
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-normal".into(), "asset-trash".into()],
                add_classification_ids: vec![fixture.child_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let entries = fixture.library.list_classifications().unwrap();
        let child = entries
            .iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(child.asset_count, 1);
        let parent = entries
            .iter()
            .find(|entry| entry.id == fixture.parent_tag.id)
            .unwrap();
        assert_eq!(parent.asset_count, 0);
    }

    #[test]
    fn list_classifications_totals_count_each_subtree_asset_once() {
        let fixture = ClassificationFixture::new();
        for (id, status) in [
            ("asset-a", "normal"),
            ("asset-b", "normal"),
            ("asset-trash", "trash"),
        ] {
            insert_asset(&fixture.library, id);
            fixture
                .library
                .connection()
                .unwrap()
                .execute("UPDATE assets SET status = ?1 WHERE id = ?2", [status, id])
                .unwrap();
        }
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into(), "asset-b".into(), "asset-trash".into()],
                add_classification_ids: vec![fixture.child_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        // asset-b is linked to both the child and its parent: one Asset for the parent.
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-b".into()],
                add_classification_ids: vec![fixture.parent_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let entries = fixture.library.list_classifications().unwrap();
        let counts = |id: &str| {
            let entry = entries.iter().find(|entry| entry.id == id).unwrap();
            (entry.asset_count, entry.total_asset_count)
        };
        assert_eq!(counts(&fixture.child_tag.id), (2, Some(2)));
        assert_eq!(counts(&fixture.parent_tag.id), (1, Some(2)));
        assert_eq!(counts(&fixture.root.id), (0, Some(2)));
        let work = entries
            .iter()
            .find(|entry| entry.name == "Blue Archive")
            .unwrap();
        assert_eq!(work.total_asset_count, Some(2));
        assert!(entries
            .iter()
            .filter(|entry| entry.asset_count == 0
                && entry.parent_id.is_none()
                && entry.id != fixture.root.id)
            .all(|entry| entry.total_asset_count == Some(0)));
    }

    #[test]
    fn list_classifications_totals_handle_siblings_and_deep_chains() {
        let fixture = ClassificationFixture::new();
        let tag = |name: &str, parent: &str| {
            fixture
                .library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Tag,
                    name: name.into(),
                    parent_id: Some(parent.into()),
                })
                .unwrap()
                .id
        };
        // child_tag (Aru) > deep > deeper; sibling sits beside child_tag under parent_tag.
        let deep = tag("Deep", &fixture.child_tag.id);
        let deeper = tag("Deeper", &deep);
        let sibling = tag("Sibling", &fixture.parent_tag.id);
        let link = |asset: &str, ids: &[&str]| {
            fixture
                .library
                .patch_asset_classifications(AssetClassificationPatch {
                    asset_ids: vec![asset.into()],
                    add_classification_ids: ids.iter().map(|id| id.to_string()).collect(),
                    remove_classification_ids: vec![],
                })
                .unwrap();
        };
        for id in ["x", "y", "z"] {
            insert_asset(&fixture.library, id);
        }
        link("x", &[&deeper, &sibling]); // across siblings
        link("y", &[&deep, &deeper]); // twice on one chain
        link("z", &[&fixture.child_tag.id]);

        let entries = fixture.library.list_classifications().unwrap();
        let total = |id: &str| {
            entries
                .iter()
                .find(|entry| entry.id == id)
                .unwrap()
                .total_asset_count
        };
        assert_eq!(total(&deeper), Some(2));
        assert_eq!(total(&deep), Some(2));
        assert_eq!(total(&fixture.child_tag.id), Some(3));
        assert_eq!(total(&sibling), Some(1));
        assert_eq!(total(&fixture.parent_tag.id), Some(3));
        assert_eq!(total(&fixture.root.id), Some(3));
    }

    #[test]
    fn batch_classification_patch_is_additive_selective_and_atomic() {
        let mut fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        insert_asset(&fixture.library, "asset-b");
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into()],
                add_classification_ids: vec![fixture.child_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into(), "asset-b".into()],
                add_classification_ids: vec![fixture.parent_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        fixture.parent_tag.asset_count = 2;
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-b")
                .unwrap(),
            vec![fixture.parent_tag.clone()]
        );

        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into()],
                add_classification_ids: vec![],
                remove_classification_ids: vec![fixture.child_tag.id.clone()],
            })
            .unwrap();
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.parent_tag.clone()]
        );

        let error = fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into(), "missing".into()],
                add_classification_ids: vec![fixture.root.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap_err();
        assert!(matches!(error, LibraryError::AssetNotFound));
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.parent_tag.clone()]
        );
    }

    #[test]
    fn setting_a_classification_enqueues_incremental_replica_work() {
        // Flow C 회귀: 관계-only 변경은 원본 재업로드 없이 복제본에 수렴해야
        // 한다. 다음 revision의 pending 큐 row가 트랜잭션 안에서 만들어지는지
        // 검증한다.
        let mut fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(fixture.root.id.clone()),
            })
            .unwrap();

        let connection = fixture.library.connection().unwrap();
        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_queue
                 WHERE entity_type = 'asset' AND entity_id = 'asset-a'
                   AND operation = 'upsert' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1);
        let revisions: Vec<i64> = connection
            .prepare(
                "SELECT revision FROM cloud_sync_queue
                 WHERE entity_type = 'asset' AND entity_id = 'asset-a'
                   AND operation = 'upsert' AND status = 'pending'
                 ORDER BY revision",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(revisions, vec![1]);
        drop(connection); // Library 단일 커넥션 잠금 해제 후 다음 mutation 진행

        // unset(제거)도 증분 work를 만든다 (제거 전파) — revision이 또 올라간다.
        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: None,
            })
            .unwrap();
        let connection = fixture.library.connection().unwrap();
        let pending_after: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_queue
                 WHERE entity_type = 'asset' AND entity_id = 'asset-a'
                   AND operation = 'upsert' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // 워커가 없는 테스트 환경에서는 첫 pending(rev1)도 그대로 남아
        // 있으므로 pending은 2개(rev 1,2)가 된다.
        assert_eq!(pending_after, 2);
        let max_revision: i64 = connection
            .query_row(
                "SELECT MAX(revision) FROM cloud_sync_queue
                 WHERE entity_type = 'asset' AND entity_id = 'asset-a'
                   AND operation = 'upsert' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(max_revision, 2);
    }

    #[test]
    fn setting_a_folder_replaces_all_direct_links_atomically() {
        let mut fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into()],
                add_classification_ids: vec![fixture.root.id.clone(), fixture.child_tag.id.clone()],
                remove_classification_ids: Vec::new(),
            })
            .unwrap();

        fixture.parent_tag.asset_count = 1;
        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap();

        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.parent_tag]
        );
    }

    #[test]
    fn setting_a_folder_can_unsort_and_rejects_partial_batches() {
        let mut fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(fixture.root.id.clone()),
            })
            .unwrap();
        fixture.root.asset_count = 1;

        let error = fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into(), "missing".into()],
                classification_id: Some(fixture.child_tag.id),
            })
            .unwrap_err();
        assert!(matches!(error, LibraryError::AssetNotFound));
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.root]
        );

        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: None,
            })
            .unwrap();
        assert!(fixture
            .library
            .get_asset_classifications("asset-a")
            .unwrap()
            .is_empty());
    }

    /// PERF-ALL-001 tighten-only gate. One asset's Classifications (with per-entry counts)
    /// must cost VM steps in proportion to the entries' links, not entries x assets, and the
    /// multi-link correction of `list_classifications` must not walk every normal asset. The
    /// pre-fix statements run on the same fixture to prove identical rows and that the
    /// thresholds catch the regression. Lower a `MAX_*` after a verified improvement; raise
    /// it only with a justified, measured reason.
    #[test]
    fn classification_counts_vm_steps_stay_proportional_to_links() {
        const ASSETS: usize = 2_000;
        const PROBE: &str = "asset-00001";
        // Measured on this fixture (bundled SQLite of rusqlite 0.40): one asset's
        // Classifications fixed 1,346, plain-`JOIN` plan 17,364; multi-link correction fixed
        // 40,083, pre-fix statement 54,711.
        const MAX_ASSET_VM_STEPS: i32 = 1_500;
        const MAX_MULTI_VM_STEPS: i32 = 44_000;

        let fixture = ClassificationFixture::new();
        let sibling = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "sibling".into(),
                parent_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap();
        {
            let mut connection = fixture.library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            {
                let mut asset = transaction
                    .prepare(
                        "INSERT INTO assets (
                            id, content_hash, media_kind, original_name, relative_path,
                            thumbnail_relative_path, byte_size, width, height, collected_at,
                            status
                         ) VALUES (?1, 'hash-' || ?1, 'image', ?1 || '.png',
                            'assets/' || ?1 || '.png', 'thumbnails/' || ?1 || '.webp',
                            1, 1, 1, '2026-08-16T00:00:00Z', ?2)",
                    )
                    .unwrap();
                let mut link = transaction
                    .prepare(
                        "INSERT INTO asset_classifications (asset_id, classification_id)
                         VALUES (?1, ?2)",
                    )
                    .unwrap();
                for index in 0..ASSETS {
                    let id = format!("asset-{index:05}");
                    let status = if index % 7 == 3 { "trash" } else { "normal" };
                    asset.execute(rusqlite::params![id, status]).unwrap();
                    // Most assets sit in the large child tag; a few small entries (and a few
                    // multi-linked assets, some trashed) hold the probe asset's Classifications.
                    let ids: &[&str] = match index % 50 {
                        1 => &[&fixture.parent_tag.id, &sibling.id],
                        2 => &[&sibling.id],
                        3 => &[&fixture.parent_tag.id],
                        _ => &[&fixture.child_tag.id],
                    };
                    for classification_id in ids {
                        link.execute(rusqlite::params![id, classification_id])
                            .unwrap();
                    }
                }
            }
            transaction.commit().unwrap();
        }

        let connection = fixture.library.connection().unwrap();
        let asset = compare_rows(
            &connection,
            super::ASSET_CLASSIFICATIONS_SQL,
            &super::ASSET_CLASSIFICATIONS_SQL.replace("CROSS JOIN", "JOIN"),
            Some(PROBE),
        );
        let multi = compare_rows(
            &connection,
            super::MULTI_LINKED_ASSETS_SQL,
            PRE_FIX_MULTI_LINKED_ASSETS_SQL,
            None,
        );
        eprintln!(
            "get_asset_classifications VM steps: fixed {}, plain JOIN {}; multi-link VM steps: fixed {}, pre-fix {}",
            asset.fixed_steps, asset.plain_steps, multi.fixed_steps, multi.plain_steps
        );
        assert_eq!(asset.fixed_rows.len(), 2);
        assert_eq!(asset.fixed_rows, asset.plain_rows);
        // Two links for each of the 40 multi-linked assets, of which the normal ones remain.
        let normal_multi = (0..ASSETS).filter(|i| i % 50 == 1 && i % 7 != 3).count();
        assert_eq!(multi.fixed_rows.len(), normal_multi * 2);
        assert_eq!(multi.fixed_rows, multi.plain_rows);
        drop(connection);
        // The product call returns the gated rows' counts (gated rows are sorted).
        let mut product = fixture
            .library
            .get_asset_classifications(PROBE)
            .unwrap()
            .into_iter()
            .map(|entry| (entry.id, entry.asset_count as i64))
            .collect::<Vec<_>>();
        let gated = asset
            .fixed_rows
            .iter()
            .map(|row| match (&row[0], &row[6]) {
                (rusqlite::types::Value::Text(id), rusqlite::types::Value::Integer(count)) => {
                    (id.clone(), *count)
                }
                other => panic!("unexpected row shape {other:?}"),
            })
            .collect::<Vec<_>>();
        product.sort();
        let mut gated = gated;
        gated.sort();
        assert_eq!(product, gated);

        for (name, compared, max) in [
            ("get_asset_classifications", &asset, MAX_ASSET_VM_STEPS),
            ("multi-link correction", &multi, MAX_MULTI_VM_STEPS),
        ] {
            assert!(
                compared.fixed_steps <= max,
                "{name} VM steps {} exceed the gate {max}",
                compared.fixed_steps
            );
            assert!(
                compared.plain_steps > max,
                "the pre-fix {name} plan ({} VM steps) no longer exceeds the gate",
                compared.plain_steps
            );
        }
    }

    /// Real-data equality check for the Classification count rewrites. Point
    /// `LAKOMICS_CLASSIFICATIONS_SNAPSHOT_DB` at the `library.sqlite` of a snapshot copy, never
    /// at the live library; it is opened read-only.
    #[test]
    #[ignore = "needs LAKOMICS_CLASSIFICATIONS_SNAPSHOT_DB"]
    fn classification_counts_match_pre_fix_plan_on_snapshot() {
        let path = std::env::var_os("LAKOMICS_CLASSIFICATIONS_SNAPSHOT_DB")
            .expect("LAKOMICS_CLASSIFICATIONS_SNAPSHOT_DB");
        let connection =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let multi = compare_rows(
            &connection,
            super::MULTI_LINKED_ASSETS_SQL,
            PRE_FIX_MULTI_LINKED_ASSETS_SQL,
            None,
        );
        eprintln!(
            "multi-link rows {}; VM steps: fixed {}, pre-fix {}",
            multi.fixed_rows.len(),
            multi.fixed_steps,
            multi.plain_steps
        );
        assert_eq!(multi.fixed_rows, multi.plain_rows);
        let linked = connection
            .prepare("SELECT DISTINCT asset_id FROM asset_classifications ORDER BY asset_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let plain = super::ASSET_CLASSIFICATIONS_SQL.replace("CROSS JOIN", "JOIN");
        let (mut fixed_steps, mut plain_steps) = (0_i64, 0_i64);
        for asset_id in &linked {
            let asset = compare_rows(
                &connection,
                super::ASSET_CLASSIFICATIONS_SQL,
                &plain,
                Some(asset_id),
            );
            assert!(!asset.fixed_rows.is_empty());
            assert_eq!(asset.fixed_rows, asset.plain_rows, "asset {asset_id}");
            fixed_steps += i64::from(asset.fixed_steps);
            plain_steps += i64::from(asset.plain_steps);
        }
        eprintln!(
            "get_asset_classifications over {} linked assets; VM steps: fixed {fixed_steps}, plain JOIN {plain_steps}",
            linked.len()
        );
    }

    /// The multi-link statement before PERF-ALL-001.
    const PRE_FIX_MULTI_LINKED_ASSETS_SQL: &str = "SELECT link.asset_id, link.classification_id
         FROM asset_classifications AS link
         JOIN assets AS asset ON asset.id = link.asset_id
         WHERE asset.status = 'normal'
           AND link.asset_id IN (
               SELECT asset_id FROM asset_classifications
               GROUP BY asset_id HAVING COUNT(*) > 1
           )
         ORDER BY link.asset_id";

    type Rows = Vec<Vec<rusqlite::types::Value>>;

    struct Compared {
        fixed_rows: Rows,
        fixed_steps: i32,
        plain_rows: Rows,
        plain_steps: i32,
    }

    /// Runs a product statement and its pre-fix form; returns every column of every row
    /// (sorted, since the multi-link order within one asset is not significant) with each
    /// statement's VM steps.
    fn compare_rows(
        connection: &rusqlite::Connection,
        fixed_sql: &str,
        plain_sql: &str,
        asset_id: Option<&str>,
    ) -> Compared {
        let run = |sql: &str| {
            let mut statement = connection.prepare(sql).unwrap();
            let columns = statement.column_count();
            let params = asset_id.map_or_else(Vec::new, |id| vec![id]);
            let mut rows = statement
                .query_map(rusqlite::params_from_iter(params), |row| {
                    (0..columns)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            let steps = statement.get_status(rusqlite::StatementStatus::VmStep);
            rows.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
            (rows, steps)
        };
        let (fixed_rows, fixed_steps) = run(fixed_sql);
        let (plain_rows, plain_steps) = run(plain_sql);
        Compared {
            fixed_rows,
            fixed_steps,
            plain_rows,
            plain_steps,
        }
    }

    fn insert_asset(library: &Library, id: &str) {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', 'asset.png', ?3, ?4, 1, 1, 1, '2026-07-30T00:00:00Z')",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.png"),
                ],
            )
            .unwrap();
    }
}
