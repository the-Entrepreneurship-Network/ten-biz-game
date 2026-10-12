import { simulateWeek, BUSINESSES, EVENTS } from './sim.js';

/**
 * One run of the game: eight weeks of a small business.
 *
 * Everything here is pure — no database, no network, no clock. The Worker
 * loads a run, calls into this, and saves what comes back; the local preview
 * harness does the same against an object in memory. One implementation, so
 * the thing you see in a screenshot is the thing students get.
 */

export const WEEKS = 8;
export const START_CASH = 5000;

/**
 * The weather is not a slot machine.
 *
 * A student who could reroll a bad week would reroll until the festival, and
 * the whole lesson — that demand is not yours to control — would be gone. The
 * event is derived from the run id and the week number, so it is the same on
 * every refresh, reproducible in a test, and decided on the server either way.
 *
 * ponytail: a hash, not a seeded PRNG. Good enough to be unguessable by a
 * fourteen-year-old; swap it if anyone ever needs a real distribution.
 */
const WEIGHTED = [
    'normal', 'normal', 'normal', 'normal',   // most weeks are ordinary
    'rain', 'rain',
    'festival',
    'competitor',
    'costly_milk',
    'exam_week',
];

export function eventFor(runId, week) {
    const s = `${runId}:${week}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return WEIGHTED[Math.abs(h) % WEIGHTED.length];
}

/** Week 1 is always ordinary — nobody should lose on their first go to weather. */
export function eventForWeek(runId, week) {
    return week <= 1 ? 'normal' : eventFor(runId, week);
}

/**
 * Play one week.
 *
 * Returns the result to show, the run as it now stands, and whether the game
 * is over. A run ends when the cash runs out or week eight is done — the
 * caller decides what to say about it.
 */
export function playWeek(run, decision) {
    const business = BUSINESSES[run.business] ? run.business : 'tea_stall';
    const event = eventForWeek(run.id, run.week);

    const result = simulateWeek({
        business,
        price: decision && decision.price,
        stockBought: decision && decision.stock,
        cashBefore: run.cash,
        event,
    });

    const cash = result.cashAfter;
    const week = run.week + 1;
    const bankrupt = cash < 0;
    const finished = !bankrupt && week > WEEKS;

    return {
        result,
        eventKey: event,
        run: { ...run, business, cash, week, over: bankrupt || finished },
        over: bankrupt || finished,
        // Why it ended, so the end screen can say something true rather than
        // congratulating a student who just went broke.
        ending: bankrupt ? 'bankrupt' : (finished ? 'finished' : null),
    };
}

/** Coins for a week. Deliberately never negative: a bad week still taught something. */
export function coinsFor(result) {
    let coins = 5;                                   // for turning up
    if (result.profit > 0) coins += 10;
    if (!result.stockOut && !result.spoiled) coins += 5;   // judged the stock well
    return coins;
}

export function newRun(id, business) {
    return {
        id,
        business: BUSINESSES[business] ? business : 'tea_stall',
        week: 1,
        cash: START_CASH,
        over: false,
    };
}

/** What the start screen offers. Kept here so the UI has no business rules in it. */
export function businessChoices() {
    return Object.entries(BUSINESSES).map(([key, b]) => ({
        key,
        name: b.name,
        rent: b.weeklyFixed,
        unitCost: b.unitCost,
        refPrice: b.refPrice,
        perishable: b.perishable,
    }));
}

export { EVENTS };
