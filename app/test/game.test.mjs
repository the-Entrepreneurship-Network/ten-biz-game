// Run: node --test test/game.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    playWeek, newRun, eventForWeek, coinsFor, WEEKS, START_CASH, businessChoices,
} from '../src/game.js';

const run = (over = {}) => ({ ...newRun('run-abc', 'tea_stall'), ...over });

test('a new run starts at week 1 with the starting cash', () => {
    const r = newRun('x', 'tea_stall');
    assert.equal(r.week, 1);
    assert.equal(r.cash, START_CASH);
    assert.equal(r.over, false);
});

test('an unknown business falls back rather than throwing at a child', () => {
    assert.equal(newRun('x', 'casino').business, 'tea_stall');
    assert.equal(playWeek({ ...run(), business: 'nonsense' }, { price: 10, stock: 50 }).run.business, 'tea_stall');
});

test('THE REROLL GUARD: the same run and week always gets the same weather', () => {
    for (let w = 1; w <= WEEKS; w += 1) {
        assert.equal(eventForWeek('run-abc', w), eventForWeek('run-abc', w));
    }
});

test('different runs do not all get the same weather', () => {
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) seen.add(eventForWeek('run-' + i, 3));
    assert.ok(seen.size > 1, 'every run got identical weather — the hash is not spreading');
});

test('week 1 is never a bad week — nobody loses their first go to rain', () => {
    for (let i = 0; i < 50; i += 1) assert.equal(eventForWeek('run-' + i, 1), 'normal');
});

test('playing a week advances the week and moves the cash', () => {
    const out = playWeek(run(), { price: 10, stock: 100 });
    assert.equal(out.run.week, 2);
    assert.notEqual(out.run.cash, START_CASH);
    assert.equal(out.over, false);
});

test('running out of money ends the run, and says why', () => {
    const out = playWeek({ ...run(), cash: 200 }, { price: 10, stock: 400 });
    assert.ok(out.run.cash < 0);
    assert.equal(out.over, true);
    assert.equal(out.ending, 'bankrupt');
});

test('finishing week 8 ends the run, and says why', () => {
    const out = playWeek({ ...run(), week: WEEKS }, { price: 10, stock: 80 });
    assert.equal(out.over, true);
    assert.equal(out.ending, 'finished');
});

test('a solvent week 8 finishes rather than reporting bankruptcy', () => {
    const out = playWeek({ ...run(), week: WEEKS, cash: 9000 }, { price: 10, stock: 80 });
    assert.equal(out.ending, 'finished');
});

test('coins are never negative — a bad week still taught something', () => {
    for (const stock of [0, 50, 120, 500]) {
        for (const price of [0, 5, 10, 40]) {
            const out = playWeek(run(), { price, stock });
            assert.ok(coinsFor(out.result) > 0, `no coins at price=${price} stock=${stock}`);
        }
    }
});

test('a profitable, well-judged week pays more than a bad one', () => {
    const good = playWeek(run(), { price: 10, stock: 120 });
    const bad = playWeek(run(), { price: 10, stock: 600 });
    assert.ok(coinsFor(good.result) > coinsFor(bad.result));
});

test('nonsense input never produces a broken run', () => {
    for (const d of [undefined, {}, { price: -5, stock: -5 }, { price: 'x', stock: 'y' }, { price: 1e9, stock: 1e9 }]) {
        const out = playWeek(run(), d);
        assert.ok(Number.isFinite(out.run.cash), 'cash became NaN');
        assert.ok(Number.isFinite(out.result.profit));
        assert.equal(out.run.week, 2);
    }
});

test('the start screen is offered real businesses with real numbers', () => {
    const choices = businessChoices();
    assert.ok(choices.length >= 3);
    for (const c of choices) {
        assert.ok(c.name && c.rent > 0 && c.unitCost > 0 && c.refPrice > c.unitCost);
        assert.equal(typeof c.perishable, 'boolean');
    }
});
