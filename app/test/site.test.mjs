// Run: node --test test/site.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demandAt, breakEvenUnits, BUSINESSES } from '../src/sim.js';
import { PAGES } from '../src/index.js';

const HOME = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const PLAY = readFileSync(new URL('../public/play.html', import.meta.url), 'utf8');

/**
 * Lift a function out of a page by counting braces.
 *
 * The landing page is static and has no build step, so its copy of the
 * break-even maths cannot be imported. Running the real thing is still better
 * than asserting on its source text.
 */
function lift(page, name) {
    const start = page.indexOf(name);
    assert.notEqual(start, -1, `${name} is missing from the page`);
    let depth = 0;
    for (let i = page.indexOf('{', start); i < page.length; i += 1) {
        if (page[i] === '{') depth += 1;
        else if (page[i] === '}') {
            depth -= 1;
            if (depth === 0) return page.slice(start, i + 1);
        }
    }
    throw new Error(`${name} never closes`);
}

const demoNumbers = new Function(
    `${lift(HOME, 'var TEA =').replace(/^var TEA =/, 'const TEA =')}
     ${lift(HOME, 'function demoNumbers')}
     return demoNumbers;`
)();

/**
 * THE POINT OF THIS FILE.
 *
 * The hero sells the product by doing arithmetic in front of a visitor. If
 * someone retunes the tea stall in sim.js, that arithmetic silently becomes a
 * lie told to every school that visits — and nothing else would catch it,
 * because the page still renders perfectly.
 */
test('the hero demo tells the truth about every price on the slider', () => {
    for (let price = 5; price <= 18; price += 1) {
        const shown = demoNumbers(price);
        const real = {
            demand: demandAt('tea_stall', price, 'normal'),
            breakEven: breakEvenUnits('tea_stall', price, 'normal'),
        };

        assert.equal(shown.demand, real.demand, `demand disagrees at ₹${price}`);

        if (real.breakEven === null) {
            assert.equal(shown.breakEven, Infinity, `₹${price} is at or below cost`);
        } else {
            assert.equal(shown.breakEven, real.breakEven, `break-even disagrees at ₹${price}`);
        }
    }
});

test('the demo constants are the real tea stall, not rounded for the page', () => {
    const tea = BUSINESSES.tea_stall;
    for (const [key, value] of Object.entries(
        { refPrice: tea.refPrice, unitCost: tea.unitCost,
          baseDemand: tea.baseDemand, weeklyFixed: tea.weeklyFixed })) {
        assert.ok(new RegExp(`${key}:\\s*${value}\\b`).test(HOME),
            `the page's TEA.${key} is not ${value}`);
    }
});

test('the slider covers a losing price at BOTH ends, which is the lesson', () => {
    // Too cheap to cover the rent, and too dear for anyone to buy. If a future
    // retune leaves only profitable prices, the demo stops teaching anything.
    assert.equal(demoNumbers(5).viable, false, 'the cheapest price should lose money');
    assert.equal(demoNumbers(18).viable, false, 'the dearest price should lose money');
    assert.equal(demoNumbers(10).viable, true, 'the reference price should work');
});

test('the rent quoted in the verdict copy matches the simulation', () => {
    // The verdict says "cover the ₹400 rent" in prose. Prose does not fail a
    // type check, so it is checked here.
    assert.ok(HOME.includes(`₹${BUSINESSES.tea_stall.weeklyFixed} rent`),
        'the hero quotes a rent figure the simulation does not use');
});

test('the home page sends people to the game, and the Worker serves it', () => {
    assert.ok(HOME.includes('href="/play"'), 'nothing links to the game');
    assert.equal(PAGES['/play'], '/play.html');
});

/**
 * Moving the game to its own page is markup surgery on working code. A dropped
 * id does not throw on load — it throws later, when a student clicks.
 */
test('play.html still has every element the game script reaches for', () => {
    const script = PLAY.slice(PLAY.indexOf('<script>'));
    const wanted = [...script.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]);
    const byId = [...script.matchAll(/\$\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]);

    const ids = [...new Set([...wanted, ...byId])];
    assert.ok(ids.length > 10, 'extracted suspiciously few ids — the regex is wrong');

    for (const id of ids) {
        assert.ok(new RegExp(`id="${id}"`).test(PLAY), `play.html is missing #${id}`);
    }
});

test('the game script still finds its sections to show and hide', () => {
    // show() hides every `main > section`, so the sections must stay direct
    // children of main or the game renders every screen at once.
    for (const id of ['pickCard', 'playCard', 'resultCard', 'endCard']) {
        assert.ok(new RegExp(`<section id="${id}"`).test(PLAY), `#${id} is not a <section>`);
    }
    assert.ok(/<main class="game">/.test(PLAY), 'the sections are no longer inside <main>');
});

test('both pages load the shared stylesheet and set a title', () => {
    for (const [name, page] of [['index', HOME], ['play', PLAY]]) {
        assert.ok(page.includes('href="/style.css"'), `${name}.html does not load style.css`);
        assert.ok(/<title>[^<]{5,}<\/title>/.test(page), `${name}.html has no real title`);
        assert.ok(page.includes('name="viewport"'), `${name}.html is not mobile-ready`);
    }
});
