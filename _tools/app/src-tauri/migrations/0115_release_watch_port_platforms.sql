-- Keep a calendar port tied to the platform release that put it on the calendar.
-- NULL preserves the existing whole-title behavior for non-ports and manual watches.
ALTER TABLE release_watch_items
ADD COLUMN tracked_platforms_json TEXT
CHECK(
 tracked_platforms_json IS NULL OR
 (json_valid(tracked_platforms_json) AND json_type(tracked_platforms_json) = 'array')
);

-- Recover the platform scope from the current IGDB calendar cache.
UPDATE release_watch_items AS watched
SET tracked_platforms_json = (
     SELECT COALESCE(json_extract(entry.value, '$.platforms'), '[]')
     FROM release_calendar_cache AS cache,
          json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry
     WHERE cache.provider = 'igdb'
       AND json_extract(entry.value, '$.id') = watched.id
       AND json_extract(entry.value, '$.port') = 1
     LIMIT 1
    ),
    platforms_json = (
     SELECT COALESCE(json_extract(entry.value, '$.platforms'), '[]')
     FROM release_calendar_cache AS cache,
          json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry
     WHERE cache.provider = 'igdb'
       AND json_extract(entry.value, '$.id') = watched.id
       AND json_extract(entry.value, '$.port') = 1
     LIMIT 1
    )
WHERE watched.kind = 'game'
  AND EXISTS (
   SELECT 1
   FROM release_calendar_cache AS cache,
        json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry
   WHERE cache.provider = 'igdb'
     AND json_extract(entry.value, '$.id') = watched.id
     AND json_extract(entry.value, '$.port') = 1
  );

DELETE FROM release_watch_dates
WHERE item_id IN (
 SELECT watched.id
 FROM release_watch_items AS watched,
      release_calendar_cache AS cache,
      json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry
 WHERE watched.kind = 'game'
   AND cache.provider = 'igdb'
   AND json_extract(entry.value, '$.id') = watched.id
   AND json_extract(entry.value, '$.port') = 1
);

INSERT OR REPLACE INTO release_watch_dates(item_id, region, platform, date, precision, checked_at)
SELECT watched.id,
       COALESCE(json_extract(release_date.value, '$.region'), ''),
       COALESCE(json_extract(release_date.value, '$.platform'), ''),
       json_extract(release_date.value, '$.date'),
       COALESCE(json_extract(release_date.value, '$.precision'), 'tbd'),
       COALESCE(watched.last_checked_at, watched.added_at)
FROM release_watch_items AS watched,
     release_calendar_cache AS cache,
     json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry,
     json_each(entry.value, '$.dates') AS release_date
WHERE watched.kind = 'game'
  AND cache.provider = 'igdb'
  AND json_extract(entry.value, '$.id') = watched.id
  AND json_extract(entry.value, '$.port') = 1;

-- Calendar entries already carry their computed headline. Only an exact date on or before
-- today is released; quarters, months, years, TBD, and future exact dates stay tracked.
UPDATE release_watch_items AS watched
SET released_at = NULL,
    next_check_at = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')
WHERE watched.kind = 'game'
  AND EXISTS (
   SELECT 1
   FROM release_calendar_cache AS cache,
        json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry
   WHERE cache.provider = 'igdb'
     AND json_extract(entry.value, '$.id') = watched.id
     AND json_extract(entry.value, '$.port') = 1
     AND (
      COALESCE(json_extract(entry.value, '$.precision'), 'tbd') <> 'exact' OR
      json_extract(entry.value, '$.date') IS NULL OR
      date(json_extract(entry.value, '$.date')) > date('now', 'localtime')
     )
  );

DELETE FROM release_watch_item_events
WHERE event_kind = 'released'
  AND read_at IS NULL
  AND item_id IN (
   SELECT watched.id
   FROM release_watch_items AS watched,
        release_calendar_cache AS cache,
        json_each(CASE WHEN json_valid(cache.entries_json) THEN cache.entries_json ELSE '[]' END) AS entry
   WHERE watched.kind = 'game'
     AND cache.provider = 'igdb'
     AND json_extract(entry.value, '$.id') = watched.id
     AND json_extract(entry.value, '$.port') = 1
     AND (
      COALESCE(json_extract(entry.value, '$.precision'), 'tbd') <> 'exact' OR
      json_extract(entry.value, '$.date') IS NULL OR
      date(json_extract(entry.value, '$.date')) > date('now', 'localtime')
     )
  );

PRAGMA user_version = 115;
