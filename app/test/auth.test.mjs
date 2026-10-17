// Run: node --test test/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeCode, normaliseCode, CODE_LENGTH, newPasswordRecord, passwordMatches,
    timingSafeEqual, hashPassword, checkSignup, cleanFirstName, MIN_PASSWORD,
    sessionExpiry, isExpired, summariseStudent, classPatterns, toCsv,
} from '../src/auth.js';

/* ── Join codes ──────────────────────────────────────────────────────── */

/** Every character a code can actually contain, found by trying every byte. */
const alphabet = () => {
    const seen = new Set();
    for (let b = 0; b < 256; b += 1) seen.add(makeCode(() => new Uint8Array(CODE_LENGTH).fill(b))[0]);
    return seen;
};

/**
 * THE POINT OF THIS TEST.
 *
 * The code is read aloud to thirty students and typed by thirteen-year-olds.
 * If someone restores the full alphabet because it looks tidier, a code with
 * an I or a 0 in it becomes a support question for every class that gets one,
 * and nothing else in the system would ever complain.
 */
test('a join code can never contain a character students confuse', () => {
    const chars = alphabet();
    for (const bad of ['I', '1', 'L', 'O', '0', 'S', '5']) {
        assert.ok(!chars.has(bad), `${bad} is reachable in a join code`);
    }
    assert.equal(chars.size, 29, 'the alphabet changed size — check the exclusions still hold');
});

test('a code is six characters, and only ever from that alphabet', () => {
    const chars = alphabet();
    for (let i = 0; i < 50; i += 1) {
        const code = makeCode();
        assert.equal(code.length, CODE_LENGTH);
        for (const c of code) assert.ok(chars.has(c), `${code} contains ${c}`);
    }
});

test('a code survives however a student types it', () => {
    // Lower case, a space in the middle, a dash they invented, trailing junk.
    for (const typed of ['bk4t9q', 'BK4T 9Q', 'bk4t-9q', '  BK4T9Q  ', 'BK4T9Q7']) {
        assert.equal(normaliseCode(typed), 'BK4T9Q', `failed on "${typed}"`);
    }
    assert.equal(normaliseCode(null), '');
    assert.equal(normaliseCode(undefined), '');
});

/* ── Passwords ───────────────────────────────────────────────────────── */

test('two teachers who pick the same password get different hashes', async () => {
    // Without a per-account salt, one leaked table plus a rainbow table is
    // every teacher who chose "password1", in one pass.
    const a = await newPasswordRecord('kettle-whistle');
    const b = await newPasswordRecord('kettle-whistle');
    assert.notEqual(a.salt, b.salt, 'the salt is not random');
    assert.notEqual(a.hash, b.hash, 'the same password hashed to the same thing');
});

test('the right password matches and a wrong one does not', async () => {
    const { salt, hash } = await newPasswordRecord('kettle-whistle');
    assert.equal(await passwordMatches('kettle-whistle', salt, hash), true);
    assert.equal(await passwordMatches('kettle-whistl', salt, hash), false);
    assert.equal(await passwordMatches('', salt, hash), false);
    // The salt is part of the secret: the same password under another salt
    // must not verify, or the salt is decoration.
    const other = await newPasswordRecord('kettle-whistle');
    assert.equal(await passwordMatches('kettle-whistle', other.salt, hash), false);
});

test('a hash is the full 256 bits, and stable for the same salt', async () => {
    const one = await hashPassword('kettle-whistle', 'ab'.repeat(16));
    const two = await hashPassword('kettle-whistle', 'ab'.repeat(16));
    assert.equal(one, two);
    assert.equal(one.length, 64, 'not 32 bytes of hex');
});

test('comparing hashes is length-safe and still correct', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);   // no throw, no true
    assert.equal(timingSafeEqual('', ''), true);
});

/* ── What we refuse ──────────────────────────────────────────────────── */

test('signup refuses what a teacher can fix, and says which', () => {
    const ok = { email: 'r@school.edu', password: 'longenough', name: 'R Nair' };
    assert.equal(checkSignup(ok), null);

    assert.match(checkSignup({ ...ok, email: 'not-an-email' }), /email/i);
    assert.match(checkSignup({ ...ok, email: '' }), /email/i);
    assert.match(checkSignup({ ...ok, password: 'a'.repeat(MIN_PASSWORD - 1) }), /password/i);
    assert.match(checkSignup({ ...ok, name: '   ' }), /name/i);
    assert.equal(checkSignup({}) === null, false, 'an empty body was accepted');
});

test('a student gives a first name and nothing more is kept', () => {
    assert.equal(cleanFirstName('  Priya  '), 'Priya');
    assert.equal(cleanFirstName('Priya   Sharma'), 'Priya Sharma');
    assert.equal(cleanFirstName('x'.repeat(100)).length, 24);
    assert.equal(cleanFirstName(''), '');
    assert.equal(cleanFirstName(null), '');
});

/* ── Sessions ────────────────────────────────────────────────────────── */

test('a session expires, and an expired one is not honoured', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const expiry = sessionExpiry(now);
    assert.equal(isExpired(expiry, now), false);
    assert.equal(isExpired(expiry, now + 29 * 86400_000), false);
    assert.equal(isExpired(expiry, now + 31 * 86400_000), true);
    // A row with no expiry is not a session that lasts forever.
    assert.equal(isExpired(null, now), true);
    assert.equal(isExpired('', now), true);
});

/* ── Reading a class ─────────────────────────────────────────────────── */

const unitCostFor = () => 4;                         // the tea stall
const weeks = (...prices) => prices.map((price, i) => ({ week: i + 1, price, business: 'tea_stall' }));

/**
 * THE POINT OF THIS TEST.
 *
 * "Worth a word" is the only thing on the dashboard that tells a teacher who
 * to talk to. If it starts flagging everyone who lost money, the list is the
 * whole class and the teacher stops reading it — losing money is the lesson,
 * not the problem.
 */
test('losing money is not what gets a student flagged', () => {
    const unlucky = summariseStudent({
        id: 's1', name: 'Arjun', unitCostFor,
        weeks: [{ week: 1, price: 9, profit: -300, business: 'tea_stall' },
                { week: 2, price: 12, profit: -150, business: 'tea_stall' },
                { week: 3, price: 7, profit: -20, business: 'tea_stall' }],
    });
    assert.equal(unlucky.needsAttention, false, 'a student who is losing but deciding was flagged');
    assert.deepEqual(unlucky.reasons, []);
});

test('pricing at or below cost is flagged — that is not understanding margin', () => {
    const below = summariseStudent({ id: 's2', name: 'Meera', unitCostFor, weeks: weeks(3, 4, 9) });
    assert.equal(below.belowCost, 2, '₹4 is AT cost and counts');
    assert.equal(below.needsAttention, true);
    assert.match(below.reasons.join(' '), /below cost/i);
});

test('never moving the price is flagged, but not before three weeks', () => {
    const two = summariseStudent({ id: 's3', name: 'Dev', unitCostFor, weeks: weeks(10, 10) });
    assert.equal(two.neverAdjusted, false, 'two weeks is not yet a habit');
    assert.equal(two.needsAttention, false);

    const three = summariseStudent({ id: 's4', name: 'Dev', unitCostFor, weeks: weeks(10, 10, 10) });
    assert.equal(three.neverAdjusted, true);
    assert.match(three.reasons.join(' '), /never changed/i);
});

test('going broke repeatedly is worth a word; going broke once is not', () => {
    const broke = (n) => summariseStudent({
        id: 's5', name: 'Sana', unitCostFor,
        weeks: Array.from({ length: 3 }, (_, i) => (
            { week: i + 1, price: 8 + i, business: 'tea_stall', bankrupt: i < n })),
    });
    assert.equal(broke(1).needsAttention, false);
    assert.equal(broke(2).needsAttention, true);
    assert.match(broke(2).reasons.join(' '), /broke/i);
});

test('a student who has not played yet reads as empty, not as a problem', () => {
    const idle = summariseStudent({ id: 's6', name: 'Rahul', unitCostFor, weeks: [] });
    assert.equal(idle.weeksPlayed, 0);
    assert.equal(idle.lastWeek, 0);
    assert.equal(idle.needsAttention, false);
    assert.equal(summariseStudent({ id: 's7', unitCostFor, weeks: [] }).name, 'Unnamed');
});

test('the furthest week is the highest, not the last one recorded', () => {
    const s = summariseStudent({
        id: 's8', name: 'Anya', unitCostFor,
        weeks: [{ week: 3, price: 9, business: 'tea_stall' },
                { week: 1, price: 9, business: 'tea_stall' }],
    });
    assert.equal(s.lastWeek, 3);
});

test('a price is only judged against a cost we actually know', () => {
    // An unknown business must not silently count as "below cost" — that
    // would flag the whole class the first time a new business is added.
    for (const cost of [undefined, null, Infinity, NaN, 'four']) {
        const s = summariseStudent({
            id: 's9', name: 'Kiran', unitCostFor: () => cost, weeks: weeks(1, 2, 3),
        });
        assert.equal(s.belowCost, 0, `a cost of ${String(cost)} flagged three prices`);
        assert.equal(s.needsAttention, false);
    }
});

test('the pre-lesson lines count students, not weeks', () => {
    const { lines, total, started } = classPatterns([
        summariseStudent({ id: 'a', name: 'A', unitCostFor, weeks: weeks(2, 3, 4) }),
        summariseStudent({ id: 'b', name: 'B', unitCostFor, weeks: weeks(10, 10, 10) }),
        summariseStudent({ id: 'c', name: 'C', unitCostFor, weeks: [] }),
    ]);
    assert.equal(total, 3);
    assert.equal(started, 2);
    assert.ok(lines.some((l) => /1 of 3 have not started/.test(l)), lines.join(' | '));
    assert.ok(lines.some((l) => /1 of 3 priced at or below cost/.test(l)), lines.join(' | '));
    assert.ok(lines.some((l) => /1 of 3 never changed/.test(l)), lines.join(' | '));
});

test('a class with nobody in it says nothing rather than dividing by zero', () => {
    assert.deepEqual(classPatterns([]), { total: 0, started: 0, lines: [] });
});

test('a class that is doing fine still gets a line', () => {
    const { lines } = classPatterns([
        summariseStudent({ id: 'a', name: 'A', unitCostFor, weeks: weeks(9, 10, 11) }),
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /pricing above cost/i);
});

test('a name with a comma does not shift every column of the CSV', () => {
    // This is how a register quietly stops matching the class it came from.
    const csv = toCsv([summariseStudent({
        id: 'a', name: 'Nair, Priya "P"', unitCostFor, weeks: weeks(9),
    })]);
    const [head, row] = csv.split('\r\n');
    assert.equal(head.split(',').length, 7);
    assert.ok(row.startsWith('"Nair, Priya ""P"""'), row);
    // Seven header columns means seven values, whatever the name contains.
    assert.equal(row.slice(row.lastIndexOf('"') + 1).split(',').length, 7);
});
