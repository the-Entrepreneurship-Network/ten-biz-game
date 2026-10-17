// Run: node --test test/teacher.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { freshDb, client } from './d1.mjs';

/**
 * Phase 2 and 3: teacher accounts, class codes, and the dashboard.
 *
 * These run against real SQLite loaded from the shipped schema.sql, so the
 * joins, the UNIQUE class code and the ON CONFLICT on re-joining are the
 * actual ones. What is being protected here is not the UI — it is that one
 * school's class cannot be read by another's teacher, and that a dashboard
 * tells the truth about who needs a word.
 */

const TEACHER = { email: 'r@school.edu', password: 'longenough1', name: 'R Nair', school: 'DAV' };

/** A signed-in teacher with a class, and the pieces to carry on with. */
async function withClass(name = 'Class 9B') {
    const db = freshDb();
    const env = { DB: db };
    const teacher = client(worker, env);
    await teacher.go('/api/teacher/signup', TEACHER);
    const cls = await (await teacher.go('/api/class', { name })).json();
    return { db, env, teacher, cls };
}

/* ── Accounts ────────────────────────────────────────────────────────── */

test('signing up signs you in, and the dashboard knows who you are', async () => {
    const { teacher } = await withClass();
    const me = await (await teacher.go('/api/teacher/me')).json();

    assert.equal(me.teacher.name, 'R Nair');
    assert.equal(me.teacher.school, 'DAV');
    assert.equal(me.classes.length, 1);
    assert.equal(me.classes[0].name, 'Class 9B');
    assert.equal(me.classes[0].students, 0);
    assert.equal(me.classes[0].code.length, 6);
});

test('the stored password is not the password', async () => {
    const { db } = await withClass();
    const [row] = db.q('SELECT pw_salt, pw_hash FROM teacher');
    assert.notEqual(row.pw_hash, TEACHER.password);
    assert.ok(!row.pw_hash.includes(TEACHER.password), 'the password is in the hash column');
    assert.equal(row.pw_hash.length, 64);
    assert.ok(row.pw_salt.length >= 32, 'no real salt was stored');
});

test('signing out ends the session on the server, not just in the browser', async () => {
    // A cookie the server still honours is not a sign-out; it is a cookie
    // that happens to have been deleted on one laptop.
    const { db, env, teacher } = await withClass();
    const token = teacher.jar.get('tsid');
    assert.ok(token);

    await teacher.go('/api/teacher/logout', {});
    assert.equal(db.q('SELECT 1 FROM session WHERE token = ?', token).length, 0);

    const replay = client(worker, env);
    replay.jar.set('tsid', token);
    assert.equal((await replay.go('/api/teacher/me')).status, 401);
});

test('a wrong password and an unknown email give the same answer', async () => {
    const { env, teacher } = await withClass();
    await teacher.go('/api/teacher/logout', {});

    const wrong = await (await teacher.go('/api/teacher/login',
        { email: TEACHER.email, password: 'not-the-password' })).json();
    const nobody = await (await client(worker, env).go('/api/teacher/login',
        { email: 'nobody@school.edu', password: 'longenough1' })).json();

    assert.equal(wrong.error, nobody.error);
    assert.match(wrong.error, /not right/i);
});

test('logging in again works and gives a different session token', async () => {
    const { env, teacher } = await withClass();
    const first = teacher.jar.get('tsid');
    await teacher.go('/api/teacher/logout', {});

    const back = client(worker, env);
    const res = await back.go('/api/teacher/login', TEACHER);
    assert.equal(res.status, 200);
    assert.notEqual(back.jar.get('tsid'), first, 'the old token was reissued');
    assert.equal((await back.go('/api/teacher/me')).status, 200);
});

test('a second account on one email is refused, and nothing is overwritten', async () => {
    const { db, env } = await withClass();
    const res = await client(worker, env).go('/api/teacher/signup',
        { ...TEACHER, name: 'Someone Else', password: 'differentpw' });

    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already has an account/i);
    assert.equal(db.q('SELECT name FROM teacher')[0].name, 'R Nair', 'the first account was clobbered');
});

test('a password too short to be one creates no account at all', async () => {
    const db = freshDb();
    const res = await client(worker, { DB: db }).go('/api/teacher/signup',
        { ...TEACHER, password: 'short' });

    assert.equal(res.status, 400);
    assert.equal(db.q('SELECT 1 FROM teacher').length, 0);
});

/* ── Who may read a class ────────────────────────────────────────────── */

/**
 * THE POINT OF THIS FILE.
 *
 * A class id is a flat string in a URL. If authorisation ever becomes "look
 * the class up by id", any teacher who has one — a forwarded link, a shared
 * screen, a lucky guess — reads another school's pupils by name. Nothing in
 * the UI would look wrong.
 */
test('a teacher cannot read another teacher\'s class, by id or as CSV', async () => {
    const { env, cls } = await withClass();

    const other = client(worker, env);
    await other.go('/api/teacher/signup',
        { email: 'other@school2.edu', password: 'longenough2', name: 'S Rao' });

    for (const path of ['/api/class?id=', '/api/class/csv?id=']) {
        const res = await other.go(path + cls.id);
        assert.equal(res.status, 404, `${path} leaked`);
        // The same answer as a class that does not exist: an id that exists
        // must not be distinguishable from one that does not.
        const missing = await other.go(path + 'definitely-not-a-class');
        assert.equal(missing.status, res.status);
        assert.deepEqual(await missing.json(), await res.json());
    }
});

test('the dashboard and the CSV both refuse a caller with no session', async () => {
    const { env, cls } = await withClass();
    const stranger = client(worker, env);

    for (const path of ['/api/teacher/me', `/api/class?id=${cls.id}`,
                        `/api/class/csv?id=${cls.id}`]) {
        assert.equal((await stranger.go(path)).status, 401, `${path} let a stranger in`);
    }
    assert.equal((await stranger.go('/api/class', { name: 'Mine now' })).status, 401);
});

test('an expired session is refused and the dead row is cleared away', async () => {
    const { db, env, teacher } = await withClass();
    const token = teacher.jar.get('tsid');
    db.q('UPDATE session SET expires_at = ? WHERE token = ?', '2020-01-01T00:00:00.000Z', token);

    assert.equal((await teacher.go('/api/teacher/me')).status, 401);
    assert.equal(db.q('SELECT 1 FROM session WHERE token = ?', token).length, 0,
        'the expired row was left to accumulate');
});

/**
 * A teacher is not a pupil. Every other API route mints a student id on first
 * contact, so if the teacher routes ever stop resolving first, every teacher
 * who opens the dashboard adds a phantom student — to their own class list.
 */
test('a teacher using the dashboard never becomes a student', async () => {
    const { db, teacher, cls } = await withClass();
    await teacher.go('/api/teacher/me');
    await teacher.go(`/api/class?id=${cls.id}`);
    await teacher.go(`/api/class/csv?id=${cls.id}`);

    assert.equal(db.q('SELECT 1 FROM student').length, 0, 'a phantom student was created');
    assert.equal(teacher.jar.has('sid'), false, 'a teacher was handed a student cookie');
});

test('a class needs a name, and class codes do not collide', async () => {
    const { db, teacher } = await withClass();
    assert.equal((await teacher.go('/api/class', { name: '  ' })).status, 400);

    for (let i = 0; i < 12; i += 1) await teacher.go('/api/class', { name: `Class ${i}` });
    const codes = db.q('SELECT code FROM class').map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length, 'two classes share a join code');
});

/* ── Joining ─────────────────────────────────────────────────────────── */

test('a student joins with the code and a first name, and keeps playing', async () => {
    const { teacher, env, cls } = await withClass();
    const student = client(worker, env);

    // Playing before joining must work — that is the free demo.
    const before = await (await student.go('/api/me')).json();
    assert.equal(before.className, null);

    const joined = await (await student.go('/api/join',
        { code: cls.code.toLowerCase(), name: ' Priya ' })).json();
    assert.deepEqual(joined, { ok: true, className: 'Class 9B', name: 'Priya' });

    const after = await (await student.go('/api/me')).json();
    assert.equal(after.className, 'Class 9B');
    assert.equal(after.name, 'Priya');
    assert.equal(after.id, before.id, 'joining gave the student a different identity');

    const me = await (await teacher.go('/api/teacher/me')).json();
    assert.equal(me.classes[0].students, 1);
});

test('a code that is wrong says so plainly instead of failing', async () => {
    const { env, cls } = await withClass();
    const student = client(worker, env);

    const short = await student.go('/api/join', { code: 'AB', name: 'Priya' });
    assert.equal(short.status, 400);
    assert.match((await short.json()).error, /6 letters/i);

    const unknown = await student.go('/api/join', { code: 'BK4T9Q', name: 'Priya' });
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /teacher/i);

    const nameless = await student.go('/api/join', { code: cls.code, name: '  ' });
    assert.equal(nameless.status, 400);
    assert.match((await nameless.json()).error, /first name/i);
});

test('joining twice, or moving class, replaces the membership', async () => {
    const { db, env, teacher, cls } = await withClass();
    const second = await (await teacher.go('/api/class', { name: 'Class 10A' })).json();
    const student = client(worker, env);

    await student.go('/api/join', { code: cls.code, name: 'Priya' });
    await student.go('/api/join', { code: cls.code, name: 'Priya' });
    assert.equal(db.q('SELECT 1 FROM membership').length, 1, 'a duplicate membership was created');

    await student.go('/api/join', { code: second.code, name: 'Priya' });
    const rows = db.q('SELECT class_id FROM membership');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].class_id, second.id, 'the student is still in the old class');
});

/* ── The dashboard, end to end ───────────────────────────────────────── */

/**
 * The whole chain at once: a student joins, plays real weeks through the real
 * API, and the teacher's dashboard reaches the right conclusion about them.
 * Every part of this works in isolation and the chain is where it breaks —
 * an event payload key renamed in one place reads as "nobody has played".
 */
test('a student who prices below cost turns up under "worth a word"', async () => {
    const { env, teacher, cls } = await withClass();
    const student = client(worker, env);
    await student.go('/api/join', { code: cls.code, name: 'Meera' });

    // Tea costs ₹4 a cup to make. Three weeks at ₹2 is not bad luck.
    await student.go('/api/run', { business: 'tea_stall' });
    for (let i = 0; i < 3; i += 1) await student.go('/api/week', { price: 2, stock: 100 });

    const board = await (await teacher.go(`/api/class?id=${cls.id}`)).json();
    assert.equal(board.class.name, 'Class 9B');
    assert.equal(board.students.length, 1);

    const [meera] = board.students;
    assert.equal(meera.name, 'Meera');
    assert.equal(meera.weeksPlayed, 3, 'the played weeks did not reach the dashboard');
    assert.equal(meera.belowCost, 3);
    assert.equal(meera.needsAttention, true);
    assert.deepEqual(board.attention.map((s) => s.name), ['Meera']);
    assert.ok(board.patterns.lines.some((l) => /1 of 1 priced at or below cost/.test(l)),
        board.patterns.lines.join(' | '));
});

test('a student pricing sensibly is on the roster and not on the list', async () => {
    const { env, teacher, cls } = await withClass();
    const student = client(worker, env);
    await student.go('/api/join', { code: cls.code, name: 'Arjun' });

    await student.go('/api/run', { business: 'tea_stall' });
    for (const price of [9, 11, 10]) await student.go('/api/week', { price, stock: 100 });

    const board = await (await teacher.go(`/api/class?id=${cls.id}`)).json();
    assert.equal(board.students[0].belowCost, 0);
    assert.equal(board.students[0].needsAttention, false);
    assert.deepEqual(board.attention, []);
});

test('the CSV is one header row and one row per student', async () => {
    const { env, teacher, cls } = await withClass();
    const student = client(worker, env);
    await student.go('/api/join', { code: cls.code, name: 'Meera' });
    await student.go('/api/run', { business: 'tea_stall' });
    await student.go('/api/week', { price: 2, stock: 100 });

    const res = await teacher.go(`/api/class/csv?id=${cls.id}`);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Class 9B results.csv"/);

    const lines = (await res.text()).split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Name,/);
    assert.match(lines[1], /^Meera,1,1,1,/);
});

test('an empty class is an empty dashboard, not an error', async () => {
    const { teacher, cls } = await withClass();
    const board = await (await teacher.go(`/api/class?id=${cls.id}`)).json();

    assert.deepEqual(board.students, []);
    assert.deepEqual(board.attention, []);
    assert.deepEqual(board.patterns, { total: 0, started: 0, lines: [] });
});

test('the teacher API answers in JSON when the database falls over', async () => {
    // Same invariant the tutor fix established: a thrown query must not reach
    // the page as an HTML 500, or every form sits there saying nothing.
    const res = await worker.fetch(
        new Request('https://example.com/api/teacher/me', { headers: { cookie: 'tsid=abcdefgh12345678' } }),
        { DB: { prepare: () => { throw new Error('D1 unreachable'); } } },
    );
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.match((await res.json()).error, /D1 unreachable/);
});

test('an unknown teacher route is a 404 in JSON, not a crash', async () => {
    const { teacher } = await withClass();
    const res = await teacher.go('/api/teacher/nonsense');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/i);
});
