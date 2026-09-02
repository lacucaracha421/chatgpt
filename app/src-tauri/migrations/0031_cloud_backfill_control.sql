-- CLOUD-006 배치 5: 전체 라이브러리 백필의 영속 실행 제어.
-- 큐와 별도로 단일 행만 유지하여 UI 재시작 뒤에도 pause/running 상태를
-- 복원한다. 기본값은 idle이므로 migration이나 앱 시작만으로 백필이
-- 자동 시작되지 않는다.
CREATE TABLE cloud_backfill_control (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'paused')),
    updated_at TEXT NOT NULL
);

INSERT INTO cloud_backfill_control (singleton, state, updated_at)
VALUES (1, 'idle', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 비어 있으면 정상 full backfill, 행이 있으면 staged rollout에서 해당
-- 자산만 progress/claim/retry 대상으로 삼는다.
CREATE TABLE cloud_backfill_scope (
    asset_id TEXT PRIMARY KEY NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

PRAGMA user_version = 31;
