// Run: node --test            (no framework, no install)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsFor, levelFor, PER_LEVEL } from '../src/score.js';

test('a known action scores, an unknown one does not throw', () => {
    assert.equal(pointsFor('quiz_correct'), 20);
    assert.equal(pointsFor('not_a_real_action'), 0);
    assert.equal(pointsFor(undefined), 0);
});

test('a wrong answer costs nothing — this is for school children', () => {
    assert.equal(pointsFor('quiz_wrong'), 0);
});

test('levels start at 1 and rise every hundred points', () => {
    assert.equal(levelFor(0), 1);
    assert.equal(levelFor(PER_LEVEL - 1), 1);
    assert.equal(levelFor(PER_LEVEL), 2);
    assert.equal(levelFor(PER_LEVEL * 3), 4);
});

test('nonsense totals never produce a level below 1', () => {
    for (const bad of [-50, NaN, 'abc', null, undefined]) {
        assert.equal(levelFor(bad), 1);
    }
});
