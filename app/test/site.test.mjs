// Run: node --test test/site.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demandAt, breakEvenUnits, BUSINESSES } from '../src/sim.js';
import { PAGES } from '../src/index.js';

const HOME = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const PLAY = readFileSync(new URL('../public/play.html', import.meta.url), 'utf8');
const TEACHER = readFileSync(new URL('../public/teacher.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

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

/* ── The teacher page ────────────────────────────────────────────────── */

test('teacher.html has every element its script reaches for', () => {
    const script = TEACHER.slice(TEACHER.indexOf('<script>'));
    const ids = [...new Set([...script.matchAll(/\$\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]))];
    assert.ok(ids.length > 15, 'extracted suspiciously few ids — the regex is wrong');
    for (const id of ids) {
        assert.ok(new RegExp(`id="${id}"`).test(TEACHER), `teacher.html is missing #${id}`);
    }
});

test('the teacher page is served, and the landing page sends schools to it', () => {
    assert.equal(PAGES['/teacher'], '/teacher.html');
    assert.ok(HOME.includes('href="/teacher"'), 'nothing on the landing page links to /teacher');
});

/**
 * THE BUG THIS CATCHES.
 *
 * `.why` is the tutor's answer box on the game page and carries an accent
 * background. The roster's note column was also class="why", so every row —
 * including the six students with nothing to say about them — came out
 * tinted, which reads as "the whole class needs a word". The page still
 * rendered perfectly; only looking at it showed the problem.
 */
test('a class that paints a background is not reused as a table cell', () => {
    const painted = [...CSS.matchAll(/^\.([\w-]+)\s*\{[^}]*background:/gm)].map((m) => m[1]);
    assert.ok(painted.includes('why'), 'the tutor box no longer paints — update this test');

    for (const cls of painted) {
        assert.ok(!new RegExp(`<td class="${cls}"`).test(TEACHER),
            `the roster reuses .${cls}, which has a background of its own`);
    }
});

test('a student can join a class from the game page without leaving it', () => {
    // The banner lives outside <main>, because the game script hides every
    // `main > section` — inside, it would vanish on the first screen change.
    const banner = PLAY.slice(PLAY.indexOf('id="joinBar"'));
    assert.ok(PLAY.indexOf('id="joinBar"') < PLAY.indexOf('<main class="game">'),
        'the join banner is inside <main> and the game will hide it');
    assert.ok(banner.includes('id="joinCode"') && banner.includes('id="joinName"'),
        'the join form asks for something other than a code and a first name');
    assert.ok(/maxlength="6"/.test(banner), 'the code field does not match the 6-character code');
    assert.ok(/maxlength="24"/.test(banner), 'the name field does not match cleanFirstName');
});

/**
 * A phone is how most of these pages get opened, and a header that hides the
 * wrong link has no visible symptom on a laptop. `.hide-sm` is the marker for
 * "this link is optional on a small screen"; a blanket rule that hides every
 * plain nav link also hid Sign out, leaving a teacher no way out on a phone.
 */
test('the small-screen header hides only links that opt in', () => {
    assert.ok(!/nav a:not\(\.btn\)\s*\{[^}]*display:\s*none/.test(CSS),
        'a blanket rule hides every plain nav link — mark links .hide-sm instead');

    const nav = TEACHER.slice(TEACHER.indexOf('<nav>'), TEACHER.indexOf('</nav>'));
    const signOut = nav.split('\n').find((l) => l.includes('id="signOut"'));
    assert.ok(signOut, 'the teacher page has no sign-out link');
    assert.ok(!signOut.includes('hide-sm'), 'Sign out disappears on a phone');
});

test('hiding something hides it, even with an inline display', () => {
    // #joinForm sets display:flex inline so it lays out when shown. An inline
    // style beats a class, so without !important the form rendered open,
    // directly under the button whose job is to open it.
    assert.match(CSS, /\.hidden\s*\{\s*display:\s*none\s*!important\s*\}/,
        '.hidden does not beat an inline display');
});
