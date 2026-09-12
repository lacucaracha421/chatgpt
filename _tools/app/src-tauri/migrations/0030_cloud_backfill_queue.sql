-- CLOUD-006 배치 3: 전체 라이브러리 백필 큐 확장.
--
-- 기존 cloud_sync_queue는 entity_type='asset' + operation='upsert'만
-- 허용한다. 백필 워커의 진행 단계(preparing/uploading/committing)를
-- 영속 상태로 구분하기 위해 status CHECK를 확장한다. 기존 4개 상태와
-- 기존 행들은 그대로 유지되며 하위 호환이다.

-- SQLite는 CHECK 제약을 ALTER로 바꿀 수 없으므로 테이블을 재작성한다.
-- cloud_sync_queue는 파생 상태(재전송 큐)만 담고, 손실되어도 assets에서
-- 재구성 가능하므로 안전한 재작성 대상이다.
CREATE TABLE cloud_sync_queue_new (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    entity_type TEXT NOT NULL CHECK (entity_type = 'asset'),
    entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
    operation TEXT NOT NULL CHECK (operation = 'upsert'),
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'preparing', 'uploading', 'committing',
        'processing', 'synced', 'failed')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    updated_at TEXT NOT NULL,
    synced_at TEXT,
    last_error TEXT,
    UNIQUE (entity_type, entity_id, operation, revision)
);

INSERT INTO cloud_sync_queue_new
    (id, entity_type, entity_id, operation, status, revision,
     retry_count, updated_at, synced_at, last_error)
SELECT id, entity_type, entity_id, operation, status, revision,
       retry_count, updated_at, synced_at, last_error
FROM cloud_sync_queue;

DROP TABLE cloud_sync_queue;
ALTER TABLE cloud_sync_queue_new RENAME TO cloud_sync_queue;

CREATE INDEX cloud_sync_queue_by_status
ON cloud_sync_queue(status, updated_at, id);

PRAGMA user_version = 30;