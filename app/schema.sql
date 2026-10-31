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

-- One run of the game per student. The week's weather is derived from the run
-- id, so nothing random needs storing and a refresh cannot reroll it.
CREATE TABLE IF NOT EXISTS run (
    id         TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES student(id),
    business   TEXT NOT NULL,
    week       INTEGER NOT NULL DEFAULT 1,
    cash       INTEGER NOT NULL,
    over       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS run_by_student ON run(student_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2: teachers, classes and sessions.
--
-- Every statement here is CREATE TABLE IF NOT EXISTS, with no ALTER, so
-- `npm run db:init` stays safe to run again against the live database. That
-- is also why a student's class lives in its own `membership` table rather
-- than as a new column on `student`: adding the column would need an ALTER,
-- and an ALTER that has already run stops the whole file.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teacher (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL DEFAULT '',
    school     TEXT NOT NULL DEFAULT '',
    pw_salt    TEXT NOT NULL,
    pw_hash    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS class (
    id         TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teacher(id),
    name       TEXT NOT NULL,
    code       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS class_by_teacher ON class(teacher_id, created_at);

-- A token in a cookie, with the row that makes it real. Stored rather than
-- signed so that signing out, or a teacher losing a laptop, actually ends the
-- session instead of waiting for it to expire.
CREATE TABLE IF NOT EXISTS session (
    token      TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teacher(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS session_by_teacher ON session(teacher_id);

-- Which class a student belongs to. One row per student, created when they
-- type a join code. A student with no row here is playing the free demo,
-- which must keep working — it is how a school sees the product at all.
CREATE TABLE IF NOT EXISTS membership (
    student_id TEXT PRIMARY KEY REFERENCES student(id),
    class_id   TEXT NOT NULL REFERENCES class(id),
    joined_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS membership_by_class ON membership(class_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4: what coins buy.
--
-- One row per upgrade per run, so a new run starts plain again — the shop you
-- built belongs to that shop, not to you forever. Still CREATE TABLE IF NOT
-- EXISTS with no ALTER, so `db:init` stays re-runnable.
--
-- Coin balance is NOT stored. A purchase is written to `event` with negative
-- points, so the SUM that already computes a student's coins keeps working
-- and the two numbers can never drift apart.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS upgrade (
    run_id     TEXT NOT NULL REFERENCES run(id),
    kind       TEXT NOT NULL,
    bought_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, kind)
);
