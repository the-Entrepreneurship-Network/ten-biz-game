// Run: node --test test/sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateWeek, demandAt, breakEvenUnits, BUSINESSES } from '../src/sim.js';

const week = (o) => simulateWeek({ business: 'tea_stall', cashBefore: 5000, ...o });

test('a sensible week turns a profit', () => {
    const r = week({ price: 10, stockBought: 120 });
    assert.equal(r.sold, 120);
    assert.equal(r.revenue, 1200);
    assert.ok(r.profit > 0, `expected profit, got ${r.profit}`);
});

test('THE LESSON: cutting price sells more but can earn less', () => {
    const full = week({ price: 10, stockBought: 200 });
    const cheap = week({ price: 5,  stockBought: 200 });
    assert.ok(cheap.sold > full.sold, 'cheaper should sell more');
    assert.ok(cheap.profit < full.profit, 'but it should earn less');
});

test('THE LESSON: you can make a profit and still run out of cash', () => {
    // Buy far more stock than you can sell: profit survives, cash does not.
    const r = simulateWeek({ business: 'tiffin', price: 80, stockBought: 200, cashBefore: 1000 });
    assert.ok(r.cashAfter < 0, 'should be out of cash');
    assert.equal(r.bankrupt, true);
});

test('unsold perishable stock is thrown away; durable stock carries over', () => {
    const tea = week({ price: 10, stockBought: 300 });
    assert.ok(tea.spoiled > 0 && tea.carryStock === 0);

    const shop = simulateWeek({ business: 'stationery', price: 50, stockBought: 300, cashBefore: 99999 });
    assert.equal(shop.spoiled, 0);
    assert.ok(shop.carryStock > 0);
});

test('buying too little leaves customers unserved', () => {
    const r = week({ price: 10, stockBought: 10 });
    assert.equal(r.sold, 10);
    assert.equal(r.stockOut, true);
});

test('rain cuts demand, a festival raises it', () => {
    const base = demandAt('tea_stall', 10, 'normal');
    assert.ok(demandAt('tea_stall', 10, 'rain') < base);
    assert.ok(demandAt('tea_stall', 10, 'festival') > base);
});

test('a supplier price rise shows up in unit cost, not in demand', () => {
    const normal = week({ price: 10, stockBought: 120 });
    const dear = week({ price: 10, stockBought: 120, event: 'costly_milk' });
    assert.equal(dear.sold, normal.sold);
    assert.ok(dear.unitCost > normal.unitCost);
    assert.ok(dear.profit < normal.profit);
});

test('break-even is impossible at or below cost', () => {
    const { unitCost } = BUSINESSES.tea_stall;
    assert.equal(breakEvenUnits('tea_stall', unitCost), null);
    assert.ok(breakEvenUnits('tea_stall', 10) > 0);
});

test('break-even is the first unit count that stops losing money', () => {
    const n = breakEvenUnits('tea_stall', 10);
    // At n units you are in the black; one unit fewer and you are not.
    assert.ok(week({ price: 10, stockBought: n }).profit >= 0);
    assert.ok(week({ price: 10, stockBought: n - 1 }).profit < 0);
});

test('a child typing nonsense does not break the game', () => {
    for (const price of [0, -5, NaN, 'abc', null, undefined, 1e9]) {
        for (const stock of [0, -3, NaN, 'xyz', null, 1e9]) {
            const r = week({ price, stockBought: stock });
            assert.ok(Number.isFinite(r.profit), `profit NaN at price=${price} stock=${stock}`);
            assert.ok(r.sold >= 0 && r.leftover >= 0);
        }
    }
});
