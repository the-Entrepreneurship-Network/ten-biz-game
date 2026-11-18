// Run: node --test test/usage.test.mjs
//
// /api/usage is how the TEN internship portal shows which schools are using
// the game. It is asked for by the portal's own server, so there is no
// teacher session behind it — just a shared key.
//
// Two things matter here and they pull against each other. The door has to
// open for the portal, and it has to stay shut for everyone else, including
// anyone who already holds a teacher login. And because the key sits in
// another system's configuration, what it unlocks has to be worth no more
// than the key itself: counts, never a person.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { freshDb, client } from './d1.mjs';

const KEY = 'a-long-usage-key-for-the-portal';
const ADMIN = 'boss@ten.net';
const ADMIN_PASS = 'a-long-staff-passphrase';

/** A world with one school, one head, one class and one pupil in it. */
async function world({ usageKey = KEY } = {}) {
    const db = freshDb();
    const env = {
        DB: db,
        ADMIN_EMAILS: ADMIN,
        ADMIN_PASSWORD: ADMIN_PASS,
        ...(usageKey === null ? {} : { USAGE_KEY: usageKey }),
    };

    const head = client(worker, env);
    await head.go('/api/teacher/signup',
        { email: 'head@dav.edu', password: 'longenough1', name: 'R Nair' });
    const sch = await (await head.go('/api/school', { name: 'DAV Public School' })).json();
    const cls = await (await head.go('/api/class', { name: 'Class 8A' })).json();

    const pupil = client(worker, env);
    await pupil.go('/api/join', { code: cls.code, name: 'Asha' });

    return { db, env, sch, cls };
}

const portal = (env) => client(worker, env, { 'x-usage-key': KEY });

test('the portal can read usage with the key', async () => {
    const { env } = await world();
    const res = await portal(env).go('/api/usage');
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.schools.length, 1);
    assert.equal(body.schools[0].name, 'DAV Public School');
    assert.equal(body.schools[0].teachers, 1);
    assert.equal(body.schools[0].classes, 1);
    assert.equal(body.schools[0].pupils, 1);

    assert.equal(body.totals.schools, 1);
    assert.equal(body.totals.classes, 1);
    assert.equal(body.totals.pupils, 1);
});

test('counts only — no email, no name of any person', async () => {
    // The key lives in another system's configuration. Whatever it unlocks is
    // worth exactly as much as that key is protected, so it must not be worth
    // much: a leak should expose how many classes a school ran, and no more.
    const { env } = await world();
    const text = await (await portal(env).go('/api/usage')).text();

    assert.ok(!text.includes('head@dav.edu'), 'a teacher email reached the portal');
    assert.ok(!text.includes('R Nair'), 'a teacher name reached the portal');
    assert.ok(!text.includes('Asha'), 'a pupil name reached the portal');
    // A class join code is a credential: anyone holding one can enrol as a pupil.
    assert.ok(!text.includes('"code"'), 'a join code reached the portal');
});

test('no key, wrong key, and a short key are all 404', async () => {
    const { env } = await world();

    const none = await client(worker, env).go('/api/usage');
    assert.equal(none.status, 404);

    const wrong = await client(worker, env, { 'x-usage-key': 'not-the-key' }).go('/api/usage');
    assert.equal(wrong.status, 404);

    // 404 rather than 403 everywhere: an unauthorised caller is not told the
    // route exists, which is how the rest of the admin surface behaves.
    assert.equal((await none.json()).error, 'Not found.');
});

test('a Worker deployed without USAGE_KEY keeps the door shut', async () => {
    // The failure that would matter most: ship the code, forget the secret,
    // and leave an open endpoint listing every school. adminPassOk refuses a
    // configured value under eight characters, so unset reads as closed.
    const { env } = await world({ usageKey: null });

    assert.equal((await portal(env).go('/api/usage')).status, 404);
    assert.equal((await client(worker, env, { 'x-usage-key': '' }).go('/api/usage')).status, 404);

    const short = await world({ usageKey: 'abc' });
    assert.equal((await client(worker, short.env, { 'x-usage-key': 'abc' }).go('/api/usage')).status, 404);
});

test('a teacher login does not open it, and the key does not open the admin pages', async () => {
    // The two doors stay separate. The admin block keeps its two locks — an
    // admin email AND the staff passphrase — and this key is neither.
    const { env } = await world();

    const teacher = client(worker, env);
    await teacher.go('/api/teacher/signup',
        { email: 'other@dav.edu', password: 'longenough3', name: 'T Other' });
    assert.equal((await teacher.go('/api/usage')).status, 404);

    // Refused, and the code is the admin surface's own business: the sign-in
    // gate answers 401 before the two-lock check is even reached. What this
    // pins is that the usage key is not a way in, whichever layer says no.
    for (const p of ['/api/admin/schools', '/api/admin/teachers']) {
        const res = await portal(env).go(p);
        assert.notEqual(res.status, 200, `the usage key opened ${p}`);
    }
});

test('POST is not a way in', async () => {
    const { env } = await world();
    const res = await portal(env).go('/api/usage', { anything: true });
    assert.notEqual(res.status, 200);
});

test('reading usage does not add a pupil to the game', async () => {
    // Every API path that is not a teacher's falls through to the student
    // branch, which mints an id on first contact. Left there, each poll from
    // the portal would add a phantom pupil — and the count it came to read
    // would be the count it was inflating.
    const { env } = await world();
    const before = await (await portal(env).go('/api/usage')).json();

    for (let i = 0; i < 3; i += 1) await portal(env).go('/api/usage');

    const after = await (await portal(env).go('/api/usage')).json();
    assert.equal(after.totals.pupils, before.totals.pupils);

    // And an unauthorised caller must not mint one either.
    await client(worker, env).go('/api/usage');
    await client(worker, env, { 'x-usage-key': 'wrong' }).go('/api/usage');
    const end = await (await portal(env).go('/api/usage')).json();
    assert.equal(end.totals.pupils, before.totals.pupils);
});
