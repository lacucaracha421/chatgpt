CREATE TABLE cloud_metadata_publication_state (
 kind TEXT PRIMARY KEY CHECK(kind IN ('classifications','saved_x','albums')),
 generation INTEGER NOT NULL DEFAULT 1,
 published_generation INTEGER NOT NULL DEFAULT 0,
 retry_after INTEGER NOT NULL DEFAULT 0,
 endpoint TEXT NOT NULL DEFAULT ''
);

INSERT INTO cloud_metadata_publication_state(kind)
VALUES('classifications'),('saved_x'),('albums');

CREATE TRIGGER cloud_metadata_classifications_insert
AFTER INSERT ON classification_entries BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_classifications_update
AFTER UPDATE ON classification_entries BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_classifications_delete
AFTER DELETE ON classification_entries BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_membership_insert
AFTER INSERT ON asset_classifications BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_membership_update
AFTER UPDATE ON asset_classifications BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_membership_delete
AFTER DELETE ON asset_classifications BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;

CREATE TRIGGER cloud_metadata_asset_insert
AFTER INSERT ON assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind IN ('classifications','saved_x');
END;
CREATE TRIGGER cloud_metadata_asset_delete
AFTER DELETE ON assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind IN ('classifications','saved_x','albums');
END;
CREATE TRIGGER cloud_metadata_asset_visibility
AFTER UPDATE OF status ON assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind IN ('classifications','saved_x','albums');
END;
CREATE TRIGGER cloud_metadata_asset_source_url
AFTER UPDATE OF source_url ON assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='saved_x';
END;
CREATE TRIGGER cloud_metadata_asset_album_fields
AFTER UPDATE OF collected_at,width,height ON assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;

CREATE TRIGGER cloud_metadata_album_insert
AFTER INSERT ON albums BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_album_update
AFTER UPDATE ON albums BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_album_delete
AFTER DELETE ON albums BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_album_membership_insert
AFTER INSERT ON asset_albums BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_album_membership_update
AFTER UPDATE ON asset_albums BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_album_membership_delete
AFTER DELETE ON asset_albums BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_video_insert
AFTER INSERT ON video_assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_video_duration
AFTER UPDATE OF duration_ms ON video_assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;
CREATE TRIGGER cloud_metadata_video_delete
AFTER DELETE ON video_assets BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='albums';
END;

PRAGMA user_version = 76;
