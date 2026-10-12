-- D1 (SQLite). Deliberately game-agnostic: `event.kind` + a JSON payload
-- absorbs whatever game loop we settle on, so choosing the mechanics later
-- does not mean a migration.

CREATE TABLE IF NOT EXISTS student (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    school     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
    student_id TEXT PRIMARY KEY REFERENCES student(id),
    level      INTEGER NOT NULL DEFAULT 1,
    points     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event (
    student_id TEXT NOT NULL REFERENCES student(id),
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    points     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    id         INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE INDEX IF NOT EXISTS event_by_student ON event(student_id, created_at);
