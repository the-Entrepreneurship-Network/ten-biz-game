// Run: node --test test/tutor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

/**
 * The tutor froze the page.
 *
 * `env.AI.run()` had no try/catch, so any failure — a wrong model name, the
 * free daily allowance spent, a rate limit — threw out of the fetch handler.
 * Cloudflare turns that into a 500 with an HTML body; the page does
 * `(await fetch(...)).json()`, which throws on HTML inside a click handler
 * that caught nothing. The promise never settled, so "Thinking…" stayed on
 * screen for good, and the button had already been disabled, so the student
 * could not even ask again.
 *
 * The invariant these tests protect: an API route answers in JSON even when
 * everything behind it has failed.
 */

/** The least D1 that ensureStudent() needs to get out of the way. */
const DB = {
    batch: async () => [],
    prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => ({}) }) }),
};

const ask = (env) => worker.fetch(
    new Request('https://example.com/api/tutor', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'sid=abcdefgh12345678' },
        body: JSON.stringify({ question: 'why did I lose money?' }),
    }),
    env,
);

test('a working tutor answers', async () => {
    const res = await ask({ DB, AI: { run: async () => ({ response: '  You priced below cost.  ' }) } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.answer, 'You priced below cost.');
});

test('THE BUG: a thrown AI call still answers in JSON, and says why', async () => {
    const res = await ask({
        DB,
        AI: { run: async () => { throw new Error('No such model'); } },
    });

    // Not a 500 with an HTML body — the page must be able to parse this.
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.match(body.error, /could not answer/i);
    assert.match(body.error, /No such model/);
    // The model name is in the message because that is the thing a deploy
    // actually gets wrong, and nobody can fix what the error will not name.
    assert.match(body.error, /@cf\//);
});

test('an empty answer is a failure the student is told about', async () => {
    const res = await ask({ DB, AI: { run: async () => ({ response: '   ' }) } });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.match(body.error, /empty/i);
    assert.equal(body.answer, undefined);
});

test('a failure anywhere else in the API is still JSON, never an HTML 500', async () => {
    // The database falling over is the realistic case: it happens before the
    // route is even chosen, and it used to escape as an unhandled throw.
    const res = await worker.fetch(
        new Request('https://example.com/api/me', { headers: { cookie: 'sid=abcdefgh12345678' } }),
        { DB: { batch: async () => { throw new Error('D1 unreachable'); },
                prepare: DB.prepare } },
    );

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();          // would throw if the body were HTML
    assert.match(body.error, /D1 unreachable/);
});

test('a non-API page is left alone when it fails — only the API is wrapped', async () => {
    // Static assets have their own error pages; dressing them up as JSON
    // would make a broken image render as `{"error":...}`.
    await assert.rejects(
        () => worker.fetch(
            new Request('https://example.com/play'),
            { ASSETS: { fetch: () => { throw new Error('asset store down'); } } },
        ),
        /asset store down/,
    );
});

/**
 * The other half of the freeze lived in the page: the button was disabled
 * before the request and only re-enabled on the success path.
 */
const PLAY = readFileSync(new URL('../public/play.html', import.meta.url), 'utf8');

test('the page re-enables the Why button however the request ends', async () => {
    const handler = PLAY.slice(PLAY.indexOf("$('whyBtn').onclick"));
    const body = handler.slice(0, handler.indexOf('\n};'));

    assert.ok(body.includes('try {'), 'the tutor call is not inside a try');
    assert.ok(body.includes('} finally {'), 'there is no finally to re-enable the button');

    // The re-enable must be in the finally, not the success path — that is the
    // difference between "ask again" and a dead button.
    const fin = body.slice(body.indexOf('} finally {'));
    assert.match(fin, /whyBtn'\)\.disabled = false/, 'the button is not re-enabled in finally');
});
