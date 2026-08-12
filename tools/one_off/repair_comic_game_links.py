import argparse
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


class RepairRefused(RuntimeError):
    pass


def readonly(database: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{database.resolve().as_posix()}?mode=ro", uri=True)


def overlap(database: Path) -> tuple[str, list[str]]:
    try:
        with closing(readonly(database)) as connection:
            rows = connection.execute(
                "SELECT id, name FROM classification_entries WHERE name IN ('만화', '게임')"
            ).fetchall()
            ids = {name: entry_id for entry_id, name in rows}
            if set(ids) != {"만화", "게임"} or len(rows) != 2:
                raise RepairRefused(f"필수 폴더 이름을 유일하게 찾지 못했습니다: {database}")
            asset_ids = [row[0] for row in connection.execute(
                """
                SELECT comic.asset_id
                FROM asset_classifications comic
                JOIN asset_classifications game ON game.asset_id = comic.asset_id
                WHERE comic.classification_id = ? AND game.classification_id = ?
                ORDER BY comic.asset_id
                """,
                (ids["만화"], ids["게임"]),
            )]
            return ids["게임"], asset_ids
    except sqlite3.Error as error:
        raise RepairRefused(f"Lakomics 데이터베이스가 아닙니다: {database}") from error


def find_candidates(root: Path) -> list[Path]:
    candidates: list[Path] = []
    for database in root.rglob("library.sqlite"):
        try:
            _, asset_ids = overlap(database)
        except RepairRefused:
            continue
        if len(asset_ids) == 2:
            candidates.append(database.resolve())
    if len(candidates) != 1:
        raise RepairRefused(f"정확히 한 개의 후보가 필요하지만 {len(candidates)}개를 찾았습니다.")
    return candidates


def repair(database: Path) -> Path:
    database = database.resolve()
    game_id, asset_ids = overlap(database)
    if len(asset_ids) != 2:
        raise RepairRefused(f"겹친 자산이 정확히 2개여야 하지만 {len(asset_ids)}개입니다.")

    backup_dir = database.parent / "backups"
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_dir / f"pre-album-repair-{stamp}-{uuid.uuid4().hex}.sqlite"
    source = sqlite3.connect(database)
    destination = sqlite3.connect(backup)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    with closing(readonly(backup)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            backup.unlink(missing_ok=True)
            raise RepairRefused("백업 무결성 검사가 실패했습니다.")

    connection = sqlite3.connect(database, isolation_level=None)
    try:
        connection.execute("BEGIN IMMEDIATE")
        current_game_id, current_asset_ids = overlap_in_connection(connection)
        if current_game_id != game_id or current_asset_ids != asset_ids:
            raise RepairRefused("백업 후 데이터가 변경되어 중단했습니다.")
        placeholders = ",".join("?" for _ in asset_ids)
        cursor = connection.execute(
            f"DELETE FROM asset_classifications WHERE classification_id = ? AND asset_id IN ({placeholders})",
            [game_id, *asset_ids],
        )
        if cursor.rowcount != 2:
            raise RepairRefused(f"삭제 대상이 2개가 아닙니다: {cursor.rowcount}")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    return backup


def overlap_in_connection(connection: sqlite3.Connection) -> tuple[str, list[str]]:
    rows = connection.execute(
        "SELECT id, name FROM classification_entries WHERE name IN ('만화', '게임')"
    ).fetchall()
    ids = {name: entry_id for entry_id, name in rows}
    if set(ids) != {"만화", "게임"} or len(rows) != 2:
        raise RepairRefused("필수 폴더 이름이 변경되었습니다.")
    asset_ids = [row[0] for row in connection.execute(
        """
        SELECT comic.asset_id FROM asset_classifications comic
        JOIN asset_classifications game ON game.asset_id = comic.asset_id
        WHERE comic.classification_id = ? AND game.classification_id = ?
        ORDER BY comic.asset_id
        """,
        (ids["만화"], ids["게임"]),
    )]
    return ids["게임"], asset_ids


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--root", type=Path, default=Path.home())
    args = parser.parse_args()
    try:
        database = find_candidates(args.root)[0]
        _, asset_ids = overlap(database)
        print(f"candidate={database}")
        print(f"asset_ids={','.join(asset_ids)}")
        if args.apply:
            backup = repair(database)
            print(f"backup={backup}")
            print("removed_count=2")
        else:
            print("dry_run=true")
        return 0
    except RepairRefused as error:
        print(f"refused={error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
