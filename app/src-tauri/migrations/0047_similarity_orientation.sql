-- Recompute only formats whose decoders can carry orientation metadata.
-- Reviews stay intact; normal/review assets are lazily re-indexed by the existing bounded worker.
UPDATE assets
SET perceptual_hash = NULL,
    perceptual_hash_quality = NULL,
    perceptual_hash_error = NULL
WHERE media_kind = 'image'
  AND (lower(relative_path) LIKE '%.jpg'
       OR lower(relative_path) LIKE '%.jpeg'
       OR lower(relative_path) LIKE '%.webp');
PRAGMA user_version = 47;
