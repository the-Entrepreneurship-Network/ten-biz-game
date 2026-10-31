// Run: node --test test/phase4.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { freshDb, client } from './d1.mjs';
import { simulateWeek, demandAt, breakEvenUnits, effectsOf, UPGRADES } from '../src/sim.js';
import { offerFor, offerForWeek, eventForWeek } from '../src/game.js';

/* ── What coins buy ──────────────────────────────────────────────────── */

test('a signboard brings more people, and nothing else moves', () => {
    const plain = demandAt('tea_stall', 10, 'normal');
    const signed = demandAt('tea_stall', 10, 'normal', ['signboard']);
    assert.ok(signed > plain, 'the signboard did nothing');
    assert.equal(signed, Math.round(plain * 1.15));
    assert.equal(breakEvenUnits('tea_stall', 10, 'normal', ['signboard']),
                 breakEvenUnits('tea_stall', 10), 'the signboard changed the rent');
});

test('a fridge stops the waste, which is the whole point of it', () => {
    const week = (upgrades) => simulateWeek({
        business: 'tea_stall', price: 10, stockBought: 300, cashBefore: 5000, upgrades,
    });
    const without = week([]);
    const withIt = week(['fridge']);

    assert.ok(without.spoiled > 0, 'nothing spoiled, so this proves nothing');
    assert.equal(withIt.spoiled, 0);
    assert.equal(withIt.wasted, 0);
    assert.equal(withIt.carryStock, without.leftover, 'the stock did not carry over');
    assert.ok(withIt.profit > without.profit);
});

/**
 * THE POINT OF THIS TEST.
 *
 * A bigger stall is the only upgrade a student can regret, because it raises
 * the rent as well as the demand. If someone ever "fixes" that as a bug, the
 * upgrade becomes a free power-up and the lesson — grow and your costs grow —
 * goes with it.
 */
test('a bigger stall raises the rent too, and break-even moves with it', () => {
    const plain = simulateWeek({ business: 'tea_stall', price: 10, stockBought: 120, cashBefore: 5000 });
    const big = simulateWeek({ business: 'tea_stall', price: 10, stockBought: 120,
                               cashBefore: 5000, upgrades: ['bigger'] });

    assert.ok(big.fixed > plain.fixed, 'a bigger stall rents for the same money');
    assert.equal(big.fixed, Math.round(plain.fixed * 1.5));
    assert.ok(big.wanted > plain.wanted, 'a bigger stall draws the same crowd');
    assert.ok(breakEvenUnits('tea_stall', 10, 'normal', ['bigger'])
            > breakEvenUnits('tea_stall', 10), 'break-even ignored the new rent');
});

test('a bigger stall can actually lose you money at a thin margin', () => {
    // The regret has to be reachable, or it is not a trade-off.
    const at = (upgrades) => simulateWeek({
        business: 'tea_stall', price: 5, stockBought: 200, cashBefore: 5000, upgrades,
    }).profit;
    assert.ok(at(['bigger']) < at([]), 'the extra rent never costs anything');
});

test('upgrades stack, and an unknown one changes nothing', () => {
    const both = effectsOf(['signboard', 'bigger']);
    assert.equal(both.demand.toFixed(4), (1.15 * 1.3).toFixed(4));
    assert.equal(both.rent, 1.5);

    assert.deepEqual(effectsOf(['not_a_thing']), { demand: 1, rent: 1, keeps: false });
    assert.deepEqual(effectsOf([]), effectsOf(undefined));
});

test('every upgrade costs something a student can actually reach', () => {
    // ~20 coins a week over 8 weeks. An upgrade nobody can afford is scenery.
    for (const [key, u] of Object.entries(UPGRADES)) {
        assert.ok(u.cost > 0 && u.cost <= 100, `${key} costs ${u.cost}`);
        assert.ok(u.name && u.blurb, `${key} has nothing to show in the shop`);
    }
});

/* ── The bulk order ──────────────────────────────────────────────────── */

const OFFER = offerFor('tea_stall');

/**
 * THE POINT OF THIS TEST.
 *
 * The card only teaches if saying yes can be the wrong answer. A student who
 * accepts a bulk order without buying the stock to serve it must come out
 * worse — that mistake IS the lesson. If this ever flips, the right play
 * becomes "always accept" and the decision stops being one.
 */
test('taking a bulk order you cannot supply is worse than refusing it', () => {
    const base = { business: 'tea_stall', price: 10, stockBought: 120,
                   cashBefore: 5000, event: 'wedding', offer: OFFER };
    const refused = simulateWeek({ ...base, takeOffer: false });
    const taken = simulateWeek({ ...base, takeOffer: true });

    assert.ok(taken.profit < refused.profit, 'over-promising cost nothing');
    assert.ok(taken.bulkShort > 0, 'the shortfall is not reported');
    assert.equal(taken.bulkSold + taken.bulkShort, OFFER.qty);
});

test('taking it after stocking up is the better week', () => {
    const base = { business: 'tea_stall', price: 10, stockBought: 220,
                   cashBefore: 5000, event: 'wedding', offer: OFFER };
    const taken = simulateWeek({ ...base, takeOffer: true });

    assert.ok(taken.profit > simulateWeek({ ...base, takeOffer: false }).profit);
    assert.equal(taken.bulkShort, 0);
    assert.equal(taken.bulkSold, OFFER.qty);
    assert.equal(taken.bulkRevenue, OFFER.qty * OFFER.price);
});

test('the bulk order is served before the street, not instead of it', () => {
    const r = simulateWeek({ business: 'tea_stall', price: 10, stockBought: 250,
                             cashBefore: 5000, event: 'wedding', offer: OFFER, takeOffer: true });
    assert.equal(r.bulkSold, OFFER.qty);
    assert.ok(r.sold > 0, 'nothing was left for ordinary customers');
    assert.equal(r.sold + r.bulkSold + r.leftover, 250, 'the stock does not add up');
    assert.equal(r.revenue, r.sold * 10 + r.bulkSold * OFFER.price);
});

test('an offer nobody accepted changes nothing at all', () => {
    const quiet = simulateWeek({ business: 'tea_stall', price: 10, stockBought: 120, cashBefore: 5000 });
    const ignored = simulateWeek({ business: 'tea_stall', price: 10, stockBought: 120,
                                   cashBefore: 5000, offer: OFFER, takeOffer: false });
    assert.equal(ignored.profit, quiet.profit);
    assert.equal(ignored.bulkSold, 0);
});

test('a bulk order is known before the week, unlike the weather', () => {
    // One that arrived after the stock was bought would not be a decision.
    const weeks = Array.from({ length: 40 }, (_, i) => `run${i}`)
        .map((id) => [id, [...Array(8).keys()].map((w) => offerForWeek(id, w + 1, 'tea_stall'))]);

    const anyOffer = weeks.some(([, list]) => list.some(Boolean));
    assert.ok(anyOffer, 'the wedding never comes up — check it is in the weighting');

    for (const [id, list] of weeks) {
        assert.equal(list[0], null, 'week 1 sprang an offer on a beginner');
        list.forEach((offer, i) => {
            const isWedding = eventForWeek(id, i + 1) === 'wedding';
            assert.equal(!!offer, isWedding, `${id} week ${i + 1} disagrees with its event`);
        });
    }
});

test('the offer is big enough and cheap enough to be a real question', () => {
    for (const business of ['tea_stall', 'stationery', 'tiffin']) {
        const o = offerFor(business);
        assert.ok(o.qty > demandAt(business, 999), 'the offer is not more than a normal week');
        assert.ok(o.price > 0, `${business} offers nothing per unit`);
    }
    assert.equal(offerFor('not_a_business'), null);
});

/* ── Buying an upgrade through the API ───────────────────────────────── */

/** A student with a shop and `coins` in hand. */
async function withCoins(coins) {
    const db = freshDb();
    const env = { DB: db };
    const me = client(worker, env);
    const { run } = await (await me.go('/api/run', { business: 'tea_stall' })).json();
    const { id } = await (await me.go('/api/me')).json();
    db.q('INSERT INTO event (student_id, kind, payload, points) VALUES (?, ?, ?, ?)',
         id, 'test_grant', '{}', coins);
    return { db, env, me, id, run };
}

test('buying an upgrade takes the coins and changes the shop', async () => {
    const { me } = await withCoins(100);
    const before = await (await me.go('/api/me')).json();
    assert.equal(before.balance, 100);

    const bought = await (await me.go('/api/upgrade', { kind: 'signboard' })).json();
    assert.equal(bought.ok, true);
    assert.equal(bought.balance, 70);
    assert.deepEqual(bought.upgrades, ['signboard']);
    assert.equal(bought.effects.demand, 1.15);

    // And the shop it describes is the shop the next week will actually use.
    const resumed = await (await me.go('/api/run')).json();
    assert.deepEqual(resumed.run.upgrades, ['signboard']);
    assert.deepEqual(resumed.shop.upgrades, ['signboard']);
});

test('spending coins does not cost you a level', async () => {
    // Buying something is not un-learning, and a level that falls when you
    // spend teaches students to hoard instead of play.
    //
    // A week has to be PLAYED on each side of the purchase: `progress` is only
    // written by /api/week, so a version of this test that just buys and reads
    // compares nothing to nothing and passes however the level is computed.
    const { me } = await withCoins(100);
    await me.go('/api/week', { price: 10, stock: 120 });
    const before = await (await me.go('/api/me')).json();
    assert.ok(before.points > 0, 'nothing was earned, so this proves nothing');

    await me.go('/api/upgrade', { kind: 'bigger' });
    await me.go('/api/week', { price: 10, stock: 120 });
    const after = await (await me.go('/api/me')).json();

    assert.ok(after.balance < before.balance, 'the purchase cost nothing');
    assert.ok(after.points > before.points, 'lifetime coins stopped counting up');
    assert.ok(after.level >= before.level, 'the level went down after a purchase');
});

test('coins you do not have buy nothing', async () => {
    const { db, me, id } = await withCoins(10);
    const res = await me.go('/api/upgrade', { kind: 'bigger' });

    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /80 coins and you have 10/);
    assert.equal(db.q('SELECT 1 FROM upgrade').length, 0, 'it was granted anyway');
    assert.equal((await (await me.go('/api/me')).json()).balance, 10, 'coins went missing');
});

test('the same upgrade cannot be bought twice', async () => {
    const { db, me } = await withCoins(100);
    await me.go('/api/upgrade', { kind: 'signboard' });
    const again = await me.go('/api/upgrade', { kind: 'signboard' });

    assert.equal(again.status, 409);
    assert.equal(db.q('SELECT 1 FROM upgrade').length, 1);
    assert.equal((await (await me.go('/api/me')).json()).balance, 70, 'charged twice');
});

test('an upgrade that does not exist is refused, not invented', async () => {
    const { db, me } = await withCoins(100);
    const res = await me.go('/api/upgrade', { kind: 'rocket' });
    assert.equal(res.status, 400);
    assert.equal(db.q('SELECT 1 FROM upgrade').length, 0);
});

test('you cannot buy anything without a shop, or after one has closed', async () => {
    const db = freshDb();
    const me = client(worker, { DB: db });
    await me.go('/api/me');
    assert.equal((await me.go('/api/upgrade', { kind: 'signboard' })).status, 400);

    const { me: me2, db: db2, run } = await withCoins(100);
    db2.q('UPDATE run SET over = 1 WHERE id = ?', run.id);
    assert.equal((await me2.go('/api/upgrade', { kind: 'signboard' })).status, 409);
});

test('a bought upgrade actually changes the next week that is played', async () => {
    // The chain that matters: bought → stored → loaded → simulated.
    //
    // Both shops play WEEK ONE, which is always calm. Comparing week 1 against
    // week 2 would compare the signboard against the weather — week 2's event
    // is drawn from the run id, so such a test passes or fails by luck.
    const play = async (buy) => {
        const { me } = await withCoins(100);
        if (buy) await me.go('/api/upgrade', { kind: buy });
        const d = await (await me.go('/api/week', { price: 10, stock: 400 })).json();
        return d.result;
    };
    const plain = await play(null);
    const boosted = await play('signboard');

    assert.equal(plain.event, boosted.event, 'the two weeks had different weather');
    assert.ok(boosted.wanted > plain.wanted, 'the signboard did not reach the simulation');
    assert.equal(boosted.wanted, Math.round(plain.wanted * 1.15));
});

/* ── The leaderboard ─────────────────────────────────────────────────── */

/** A class with `names` in it, each having finished a run with that cash. */
async function classOf(entries) {
    const db = freshDb();
    const env = { DB: db };
    const teacher = client(worker, env);
    await teacher.go('/api/teacher/signup',
        { email: 't@s.edu', password: 'longenough1', name: 'R Nair' });
    const cls = await (await teacher.go('/api/class', { name: 'Class 9B' })).json();

    const players = [];
    for (const [name, cash, weeks = 4] of entries) {
        const p = client(worker, env);
        await p.go('/api/join', { code: cls.code, name });
        const { id } = await (await p.go('/api/me')).json();
        db.q('INSERT INTO run (id, student_id, business, week, cash, over) VALUES (?,?,?,?,?,0)',
             'run-' + name, id, 'tea_stall', weeks, cash);
        players.push({ name, player: p, id });
    }
    return { db, env, cls, players };
}

test('the class is ranked on the best shop anyone finished with', async () => {
    const { players } = await classOf([['Aarav', 7000], ['Meera', 9000], ['Dev', 5500]]);
    const board = await (await players[0].player.go('/api/leaderboard')).json();

    assert.equal(board.className, 'Class 9B');
    assert.deepEqual(board.top.map((r) => r.name), ['Meera', 'Aarav', 'Dev']);
    assert.deepEqual(board.top.map((r) => r.rank), [1, 2, 3]);
    assert.equal(board.top[0].cash, 9000);
    assert.equal(board.you.name, 'Aarav');
    assert.equal(board.you.rank, 2);
});

/**
 * Thirty teenagers in one room. The top ten is a scoreboard; a full ordering
 * is a public list of who is worst at this, which is a punishment. The
 * teacher already sees who is struggling, privately, on their own dashboard.
 */
test('there are ten places and no bottom of the table', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => [`P${i}`, 9000 - i * 100]);
    const { players } = await classOf(entries);
    const last = players[14];
    const board = await (await last.player.go('/api/leaderboard')).json();

    assert.equal(board.top.length, 10, 'more than ten students were listed');
    assert.equal(board.players, 15);
    assert.ok(!board.top.some((r) => r.name === 'P14'), 'the bottom of the class is on display');

    // But you are still told where you are — fourteenth is fine, invisible is not.
    assert.equal(board.you.rank, 15);
    assert.equal(board.you.name, 'P14');
    assert.equal(board.you.you, true);
});

test('a shop nobody has played yet is not on the board', async () => {
    // Everyone starts on the same cash, so unplayed runs would rank above
    // anyone who tried, lost money, and learned something.
    const { players } = await classOf([['Aarav', 7000, 3], ['Idle', 5000, 1]]);
    const board = await (await players[0].player.go('/api/leaderboard')).json();

    assert.deepEqual(board.top.map((r) => r.name), ['Aarav']);
    assert.equal(board.players, 1);
});

test('one class cannot see another class on its board', async () => {
    const { env, players } = await classOf([['Aarav', 7000]]);
    const other = client(worker, env);
    await other.go('/api/teacher/signup',
        { email: 'b@s2.edu', password: 'longenough2', name: 'S Rao' });
    const cls2 = await (await other.go('/api/class', { name: 'Class 10A' })).json();

    const outsider = client(worker, env);
    await outsider.go('/api/join', { code: cls2.code, name: 'Stranger' });
    await outsider.go('/api/run', { business: 'tea_stall' });
    await outsider.go('/api/week', { price: 10, stock: 100 });

    const board = await (await players[0].player.go('/api/leaderboard')).json();
    assert.deepEqual(board.top.map((r) => r.name), ['Aarav'],
        'a student from another class is on this board');
});

test('playing alone gets an empty board, not an error', async () => {
    const db = freshDb();
    const solo = client(worker, { DB: db });
    const res = await solo.go('/api/leaderboard');

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { className: null, top: [], you: null });
});
