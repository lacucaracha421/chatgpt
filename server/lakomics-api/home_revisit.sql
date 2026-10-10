-- Shared by the native Home command and the tablet Home route.
-- The caller supplies revisit_assets(id, collected_at) with visible image/GIF assets.
-- :day is a fixed UTC+09:00 calendar day. February 29 clamps to February 28.
, month_start AS (
  SELECT date(:day, 'start of month', '-1 year') AS first
), target AS (
  SELECT date(first, '+' || (min(CAST(strftime('%d', :day) AS INTEGER),
    CAST(strftime('%d', date(first, '+1 month', '-1 day')) AS INTEGER)) - 1) || ' days') AS day
  FROM month_start
), candidates AS (
  SELECT id, julianday(collected_at) AS saved_at,
    CAST(abs(julianday(date(collected_at, '+9 hours')) - julianday(target.day)) AS INTEGER) AS distance
  FROM revisit_assets CROSS JOIN target
), eligible AS (
  SELECT * FROM candidates WHERE distance <= 7
)
SELECT id, distance FROM eligible
WHERE distance = 0 OR NOT EXISTS (SELECT 1 FROM eligible WHERE distance = 0)
ORDER BY distance ASC, saved_at DESC, id COLLATE BINARY ASC
LIMIT 20
