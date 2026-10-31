// Run: node --test test/school.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { freshDb, client } from './d1.mjs';
import { tempPassword, isAdminEmail, isHead, CODE_LENGTH } from '../src/auth.js';

const ADMIN = 'boss@ten.net';

/** A school with a head, and whatever other teachers you ask for. */
async function school({ admin = ADMIN, name = 'DAV Public School' } = {}) {
    const db = freshDb();
    const env = { DB: db, ADMIN_EMAILS: admin };
    const head = client(worker, env);
    await head.go('/api/teacher/signup',
        { email: 'head@dav.edu', password: 'longenough1', name: 'R Nair' });
    const sch = await (await head.go('/api/school', { name })).json();
    return { db, env, head, sch };
}

/** Another teacher, signed up with the school's code. */
async function colleague(env, sch, who = 'S Rao', email = 'rao@dav.edu') {
    const c = client(worker, env);
    await c.go('/api/teacher/signup',
        { email, password: 'longenough2', name: who, schoolCode: sch.code });
    return c;
}

/* ── Making a school ─────────────────────────────────────────────────── */

test('whoever creates the school runs it, and gets a code to hand out', async () => {
    const { head, sch } = await school();
    assert.equal(sch.role, 'head');
    assert.equal(sch.code.length, CODE_LENGTH);

    const me = await (await head.go('/api/teacher/me')).json();
    assert.equal(me.school.name, 'DAV Public School');
    assert.equal(me.school.role, 'head');
    assert.equal(me.school.code, sch.code);
});

test('a teacher joins with the code at signup and lands in the school', async () => {
    const { env, sch } = await school();
    const rao = await colleague(env, sch);

    const me = await (await rao.go('/api/teacher/me')).json();
    assert.equal(me.school.name, 'DAV Public School');
    assert.equal(me.school.role, 'teacher');
});

/**
 * A teacher who could read the school code could enrol anybody into the
 * school — and a school's roster is who can see its pupils.
 */
test('only the head can read the school code, on EVERY route that returns it', async () => {
    const { env, sch, head } = await school();
    const rao = await colleague(env, sch);

    // Checking one route is not enough: the code was gated on /api/school and
    // handed out freely by /api/teacher/me, which is the one the page reads.
    for (const path of ['/api/school', '/api/teacher/me']) {
        assert.equal((await (await rao.go(path)).json()).school.code, null,
            `${path} leaked the school code to a plain teacher`);
        assert.equal((await (await head.go(path)).json()).school.code, sch.code,
            `${path} hid the code from the head`);
    }

    // And nothing else in either reply carries it.
    for (const path of ['/api/school', '/api/teacher/me']) {
        assert.ok(!JSON.stringify(await (await rao.go(path)).json()).includes(sch.code),
            `${path} contains the code somewhere else in the body`);
    }
});

test('a wrong school code still creates the account, just without a school', async () => {
    // Failing the whole signup over a mistyped code would be a worse morning
    // than joining from inside afterwards.
    const { env } = await school();
    const lost = client(worker, env);
    const res = await lost.go('/api/teacher/signup',
        { email: 'lost@x.edu', password: 'longenough3', name: 'T Who', schoolCode: 'ZZZZZZ' });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).school, null);
    assert.equal((await (await lost.go('/api/teacher/me')).json()).school, null);
});

test('a teacher can join a school later, but not two at once', async () => {
    const { env, sch } = await school();
    const solo = client(worker, env);
    await solo.go('/api/teacher/signup', { email: 's@x.edu', password: 'longenough4', name: 'Solo' });

    const joined = await (await solo.go('/api/school/join', { code: sch.code.toLowerCase() })).json();
    assert.equal(joined.role, 'teacher');

    assert.equal((await solo.go('/api/school/join', { code: sch.code })).status, 409);
    assert.equal((await solo.go('/api/school', { name: 'Another School' })).status, 409);
});

test('a teacher in no school keeps working exactly as before', async () => {
    // Every account made before schools existed is in this state.
    const db = freshDb();
    const env = { DB: db };
    const solo = client(worker, env);
    await solo.go('/api/teacher/signup', { email: 's@x.edu', password: 'longenough5', name: 'Solo' });
    const cls = await (await solo.go('/api/class', { name: 'Class 9B' })).json();

    const me = await (await solo.go('/api/teacher/me')).json();
    assert.equal(me.school, null);
    assert.equal(me.classes.length, 1);
    assert.equal(me.classes[0].mine, true);
    assert.equal((await solo.go(`/api/class?id=${cls.id}`)).status, 200);
});

/* ── Who may open a class ────────────────────────────────────────────── */

/**
 * THE POINT OF THIS FILE.
 *
 * Phase 6 widens who can read a class for the first time — a head can now
 * open a colleague's. Every other combination must stay shut, and the failure
 * is silent: a class full of named children read by the wrong school.
 */
test('a head can open a colleague\'s class; the colleague cannot open theirs', async () => {
    const { env, head, sch } = await school();
    const rao = await colleague(env, sch);
    const raosClass = await (await rao.go('/api/class', { name: 'Class 10A' })).json();
    const headsClass = await (await head.go('/api/class', { name: 'Class 9B' })).json();

    assert.equal((await head.go(`/api/class?id=${raosClass.id}`)).status, 200,
        'the head cannot see their own school');
    assert.equal((await rao.go(`/api/class?id=${headsClass.id}`)).status, 404,
        'a plain teacher read another teacher\'s class');
});

test('two teachers in one school still cannot read each other', async () => {
    const { env, sch } = await school();
    const rao = await colleague(env, sch);
    const das = await colleague(env, sch, 'P Das', 'das@dav.edu');
    const raosClass = await (await rao.go('/api/class', { name: 'Class 10A' })).json();

    assert.equal((await das.go(`/api/class?id=${raosClass.id}`)).status, 404);
    assert.equal((await das.go(`/api/class/csv?id=${raosClass.id}`)).status, 404);
});

test('a head of one school cannot read another school', async () => {
    const { env, sch } = await school();
    const rao = await colleague(env, sch);
    const raosClass = await (await rao.go('/api/class', { name: 'Class 10A' })).json();

    const other = client(worker, env);
    await other.go('/api/teacher/signup',
        { email: 'head@other.edu', password: 'longenough6', name: 'Other Head' });
    await other.go('/api/school', { name: 'Other School' });

    const res = await other.go(`/api/class?id=${raosClass.id}`);
    assert.equal(res.status, 404);
    // Identical to an id that does not exist, so one cannot be told from the other.
    const missing = await other.go('/api/class?id=nope');
    assert.deepEqual(await res.json(), await missing.json());
});

test('the head\'s class list shows the whole school, and whose each class is', async () => {
    const { env, head, sch } = await school();
    const rao = await colleague(env, sch);
    await rao.go('/api/class', { name: 'Class 10A' });
    await head.go('/api/class', { name: 'Class 9B' });

    const me = await (await head.go('/api/teacher/me')).json();
    assert.equal(me.classes.length, 2);
    assert.deepEqual(
        Object.fromEntries(me.classes.map((c) => [c.name, { mine: c.mine, teacher: c.teacher }])),
        { 'Class 9B': { mine: true, teacher: 'R Nair' },
          'Class 10A': { mine: false, teacher: 'S Rao' } });

    // The colleague's own list is still only theirs.
    assert.deepEqual((await (await rao.go('/api/teacher/me')).json()).classes.map((c) => c.name),
        ['Class 10A']);
});

/* ── Fixing a class ──────────────────────────────────────────────────── */

async function classWithPupil(env, teacher, name = 'Priya') {
    const cls = await (await teacher.go('/api/class', { name: 'Class 9B' })).json();
    const pupil = client(worker, env);
    await pupil.go('/api/join', { code: cls.code, name });
    const { id } = await (await pupil.go('/api/me')).json();
    return { cls, pupil, studentId: id };
}

test('a teacher can fix a misspelled name', async () => {
    const { env, head } = await school();
    const { cls, pupil, studentId } = await classWithPupil(env, head, 'Priyaa');

    const d = await (await head.go('/api/class/student',
        { classId: cls.id, studentId, name: '  Priya  ' })).json();
    assert.equal(d.name, 'Priya');
    assert.equal((await (await pupil.go('/api/me')).json()).name, 'Priya');
});

test('removing a student takes them off the roster and nothing else', async () => {
    // Their shop and coins survive, so a removal by mistake is undone by
    // typing the class code again.
    const { env, head } = await school();
    const { cls, pupil, studentId } = await classWithPupil(env, head);
    await pupil.go('/api/run', { business: 'tea_stall' });
    await pupil.go('/api/week', { price: 10, stock: 120 });
    const before = await (await pupil.go('/api/me')).json();

    await head.go('/api/class/student', { classId: cls.id, studentId, remove: true });

    const board = await (await head.go(`/api/class?id=${cls.id}`)).json();
    assert.deepEqual(board.students, [], 'the student is still on the roster');

    const after = await (await pupil.go('/api/me')).json();
    assert.equal(after.className, null);
    // `balance` is summed from the event rows, so it is the number that moves
    // if a removal ever starts deleting history. `points` comes from the
    // progress table and would not notice.
    assert.ok(before.balance > 0, 'nothing was earned, so this proves nothing');
    assert.equal(after.balance, before.balance, 'their coins were taken too');
    assert.equal(after.points, before.points, 'their level was taken too');

    await pupil.go('/api/join', { code: cls.code, name: 'Priya' });
    assert.equal((await (await head.go(`/api/class?id=${cls.id}`)).json()).students.length, 1);
});

test('a teacher cannot touch a student who is not in their class', async () => {
    const { env, head, sch } = await school();
    const rao = await colleague(env, sch);
    const { cls } = await classWithPupil(env, head);
    const { studentId: outsider } = await classWithPupil(env, rao, 'Outsider');

    // Right class, wrong student.
    assert.equal((await head.go('/api/class/student',
        { classId: cls.id, studentId: outsider, name: 'Hacked' })).status, 404);
    // And a class that is not theirs at all.
    assert.equal((await rao.go('/api/class/student',
        { classId: cls.id, studentId: outsider, name: 'Hacked' })).status, 404);
});

/* ── Your own password ───────────────────────────────────────────────── */

test('changing your password works, and signs your other devices out', async () => {
    const { db, env, head } = await school();
    const otherDevice = client(worker, env);
    await otherDevice.go('/api/teacher/login', { email: 'head@dav.edu', password: 'longenough1' });
    assert.equal((await otherDevice.go('/api/teacher/me')).status, 200);

    const res = await head.go('/api/teacher/password',
        { current: 'longenough1', next: 'a-much-better-one' });
    assert.equal(res.status, 200);

    assert.equal((await otherDevice.go('/api/teacher/me')).status, 401, 'the old session survived');
    assert.equal((await head.go('/api/teacher/me')).status, 200, 'it signed ME out too');

    const fresh = client(worker, env);
    assert.equal((await fresh.go('/api/teacher/login',
        { email: 'head@dav.edu', password: 'a-much-better-one' })).status, 200);
    assert.equal((await client(worker, env).go('/api/teacher/login',
        { email: 'head@dav.edu', password: 'longenough1' })).status, 401);
});

test('the wrong current password changes nothing', async () => {
    const { env, head } = await school();
    assert.equal((await head.go('/api/teacher/password',
        { current: 'not-it', next: 'a-much-better-one' })).status, 401);
    assert.equal((await head.go('/api/teacher/password',
        { current: 'longenough1', next: 'short' })).status, 400);

    assert.equal((await client(worker, env).go('/api/teacher/login',
        { email: 'head@dav.edu', password: 'longenough1' })).status, 200);
});

/* ── TEN staff ───────────────────────────────────────────────────────── */

test('the admin page does not exist for anyone who is not an admin', async () => {
    const { env, head } = await school();                 // head is not the admin email
    for (const path of ['/api/admin/schools', '/api/admin/teachers']) {
        const res = await head.go(path);
        assert.equal(res.status, 404, `${path} answered a non-admin`);
    }
    assert.equal((await head.go('/api/admin/reset', { teacherId: 'x' })).status, 404);
    assert.equal((await head.go('/api/settings', { price: 'free' })).status, 404);
});

/**
 * An admin list that is missing must mean nobody, not everybody. This is the
 * failure that would hand the reset-any-password button to the whole internet.
 */
test('with no admin configured, nobody is an admin', async () => {
    const { head } = await school({ admin: undefined });
    assert.equal((await head.go('/api/admin/schools')).status, 404);

    assert.equal(isAdminEmail('a@b.com', undefined), false);
    assert.equal(isAdminEmail('a@b.com', ''), false);
    assert.equal(isAdminEmail('', 'a@b.com'), false);
    assert.equal(isAdminEmail('a@b.com', 'a@b.com'), true);
    assert.equal(isAdminEmail('  A@B.com ', 'a@b.com,c@d.com'), true, 'case or spacing locked an admin out');
});

test('an admin sees every school and every teacher with no school', async () => {
    const { env, sch } = await school({ admin: 'boss@ten.net' });
    await colleague(env, sch);
    const solo = client(worker, env);
    await solo.go('/api/teacher/signup', { email: 'solo@x.edu', password: 'longenough7', name: 'Solo' });

    const boss = client(worker, env);
    await boss.go('/api/teacher/signup',
        { email: 'boss@ten.net', password: 'longenough8', name: 'TEN' });

    const d = await (await boss.go('/api/admin/schools')).json();
    assert.equal(d.schools.length, 1);
    assert.equal(d.schools[0].name, 'DAV Public School');
    assert.equal(d.schools[0].teachers, 2);
    // Solo and the admin themselves both belong to no school.
    assert.deepEqual(d.unaffiliated.map((t) => t.email).sort(), ['boss@ten.net', 'solo@x.edu']);
});

/**
 * The whole reason this page exists: a teacher who forgets their password is
 * otherwise locked out forever, with no email service to recover through.
 */
test('an admin can let a locked-out teacher back in', async () => {
    const { env } = await school({ admin: 'boss@ten.net' });
    const boss = client(worker, env);
    await boss.go('/api/teacher/signup',
        { email: 'boss@ten.net', password: 'longenough8', name: 'TEN' });

    const list = await (await boss.go('/api/admin/teachers')).json();
    const locked = list.teachers.find((t) => t.email === 'head@dav.edu');
    assert.ok(locked, 'the locked-out teacher is not in the list');

    const reset = await (await boss.go('/api/admin/reset', { teacherId: locked.id })).json();
    assert.ok(reset.password && reset.password.length >= 12, 'no password to read out');

    // The new one works, the old one does not.
    assert.equal((await client(worker, env).go('/api/teacher/login',
        { email: 'head@dav.edu', password: reset.password })).status, 200);
    assert.equal((await client(worker, env).go('/api/teacher/login',
        { email: 'head@dav.edu', password: 'longenough1' })).status, 401);
});

test('a reset drops every session that teacher had', async () => {
    // If the reason for the reset is that someone else knows the password,
    // leaving their session alive defeats the entire exercise.
    const { env, head } = await school({ admin: 'boss@ten.net' });
    assert.equal((await head.go('/api/teacher/me')).status, 200);

    const boss = client(worker, env);
    await boss.go('/api/teacher/signup',
        { email: 'boss@ten.net', password: 'longenough8', name: 'TEN' });
    const list = await (await boss.go('/api/admin/teachers')).json();
    await boss.go('/api/admin/reset',
        { teacherId: list.teachers.find((t) => t.email === 'head@dav.edu').id });

    assert.equal((await head.go('/api/teacher/me')).status, 401, 'the old session lived on');
});

test('a temporary password is readable but not guessable', async () => {
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) seen.add(tempPassword());
    assert.equal(seen.size, 40, 'two temporary passwords came out the same');

    for (const pw of seen) {
        assert.match(pw, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, pw);
        // Spoken down a phone, so the ambiguous characters are gone here too.
        for (const bad of ['I', '1', 'L', 'O', '0', 'S', '5']) {
            assert.ok(!pw.includes(bad), `${pw} contains ${bad}`);
        }
    }
});

/* ── The text you can change without me ──────────────────────────────── */

test('settings are public to read and admin-only to write', async () => {
    const { env, head } = await school({ admin: 'boss@ten.net' });
    const boss = client(worker, env);
    await boss.go('/api/teacher/signup',
        { email: 'boss@ten.net', password: 'longenough8', name: 'TEN' });

    assert.deepEqual(await (await client(worker, env).go('/api/settings')).json(), {});

    const saved = await (await boss.go('/api/settings',
        { price: '₹15,000 per year', contact_email: 'growth@entrepreneurshipnetwork.net' })).json();
    assert.equal(saved.price, '₹15,000 per year');

    // Anyone, signed in or not, can read it — the landing page has no login.
    const anon = await (await client(worker, env).go('/api/settings')).json();
    assert.equal(anon.price, '₹15,000 per year');

    assert.equal((await head.go('/api/settings', { price: 'free for me' })).status, 404);
    assert.equal((await (await client(worker, env).go('/api/settings')).json()).price,
        '₹15,000 per year', 'a non-admin changed the price');
});

test('only the known settings keys are stored or returned', async () => {
    const { db, env } = await school({ admin: 'boss@ten.net' });
    const boss = client(worker, env);
    await boss.go('/api/teacher/signup',
        { email: 'boss@ten.net', password: 'longenough8', name: 'TEN' });

    await boss.go('/api/settings', { price: '₹1', evil: '<script>', contact_email: 'a@b.com' });
    const out = await (await boss.go('/api/settings')).json();
    assert.deepEqual(Object.keys(out).sort(), ['contact_email', 'price']);
    assert.equal(db.q("SELECT 1 FROM setting WHERE key = 'evil'").length, 0);
});

test('isHead only says yes to a head', () => {
    assert.equal(isHead({ role: 'head' }), true);
    assert.equal(isHead({ role: 'teacher' }), false);
    assert.equal(isHead(null), false);
    assert.equal(isHead(undefined), false);
    assert.equal(isHead({}), false);
});
