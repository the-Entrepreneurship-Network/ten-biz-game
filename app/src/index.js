import { pointsFor, levelFor } from './score.js';
import { playWeek, newRun, coinsFor, businessChoices, WEEKS, EVENTS } from './game.js';
import { breakEvenUnits, BUSINESSES } from './sim.js';

/**
 * One Worker: static files, the game API, and the tutor.
 *
 * Runs entirely on Cloudflare's free tier — Workers for the code, D1 for the
 * data, Workers AI for the tutor. No server, no GPU, no key to rotate.
 */

const TUTOR_MODEL = '@cf/meta/llama-3.1-8b-instruct';   // verify against `wrangler ai models`

const SYSTEM = [
    'You are a business tutor for school students aged 13 to 17 in India.',
    'Explain with small, concrete examples: a tea stall, a stationery shop, a tiffin service.',
    'Answer in under 120 words. Never invent figures and never give financial advice.',
    'If the student is wrong, say what is wrong and give one hint. Do not give the full answer.',
].join(' ');

/** Extension-less paths the site hands out, and the file each one serves. */
export const PAGES = { '/play': '/play.html' };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

/**
 * Who is this student?
 *
 * ponytail: an opaque id in a cookie, NOT authentication — any caller can
 * claim any id. Fine while the only data is a points total and nothing is
 * shown to anyone else. Before a teacher dashboard, a parent login, or any
 * personal detail beyond a first name, this must become a real session.
 */
function studentId(request) {
    const raw = request.headers.get('cookie') || '';
    const hit = /(?:^|;\s*)sid=([A-Za-z0-9_-]{8,64})(?:;|$)/.exec(raw);
    return hit ? hit[1] : null;
}

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 32);

async function ensureStudent(db, id) {
    await db.batch([
        db.prepare('INSERT OR IGNORE INTO student (id) VALUES (?)').bind(id),
        db.prepare('INSERT OR IGNORE INTO progress (student_id) VALUES (?)').bind(id),
    ]);
}

async function readBody(request) {
    // A body that is not JSON is the caller's mistake, not a 500.
    try { return await request.json(); } catch (_) { return null; }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (!path.startsWith('/api/')) {
            // Clean URLs. `/play` is the link that ends up in a slide or on a
            // whiteboard, so it should not carry a file extension. Static
            // asset handling may strip `.html` on its own depending on how it
            // is configured; mapping it here means the link works regardless.
            const page = PAGES[path];
            if (page) return env.ASSETS.fetch(new Request(new URL(page, url), request));
            return env.ASSETS.fetch(request);
        }

        // Every API call belongs to a student; the first call mints the id.
        let id = studentId(request);
        const minted = !id;
        if (minted) id = newId();
        await ensureStudent(env.DB, id);

        const reply = (body, status = 200) => {
            const res = json(body, status);
            if (minted) {
                res.headers.append('set-cookie',
                    `sid=${id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
            }
            return res;
        };

        if (path === '/api/me') {
            const row = await env.DB
                .prepare('SELECT level, points FROM progress WHERE student_id = ?')
                .bind(id).first();
            return reply({ id, level: row?.level ?? 1, points: row?.points ?? 0 });
        }

        if (path === '/api/event' && request.method === 'POST') {
            const body = await readBody(request);
            if (!body || typeof body.kind !== 'string') {
                return reply({ error: 'send {"kind":"..."}' }, 400);
            }
            const gained = pointsFor(body.kind);
            // Cap the stored payload so one caller cannot fill the free tier.
            const payload = JSON.stringify(body.payload ?? {}).slice(0, 2000);

            await env.DB.prepare(
                'INSERT INTO event (student_id, kind, payload, points) VALUES (?, ?, ?, ?)'
            ).bind(id, body.kind.slice(0, 64), payload, gained).run();

            // Recompute from the event log rather than trusting a running total:
            // a replayed or duplicated request cannot inflate a score.
            const sum = await env.DB
                .prepare('SELECT COALESCE(SUM(points), 0) AS points FROM event WHERE student_id = ?')
                .bind(id).first();
            const points = sum?.points ?? 0;
            const level = levelFor(points);

            await env.DB.prepare(
                'UPDATE progress SET points = ?, level = ?, updated_at = datetime(\'now\') WHERE student_id = ?'
            ).bind(points, level, id).run();

            return reply({ gained, points, level });
        }

        if (path === '/api/businesses') {
            return reply({ choices: businessChoices(), weeks: WEEKS });
        }

        // Start a run. Choosing again replaces the old one: a student is
        // allowed to start over, and losing is meant to be cheap.
        if (path === '/api/run' && request.method === 'POST') {
            const body = await readBody(request);
            const run = newRun(newId(), String(body?.business || ''));
            await env.DB.prepare(
                'INSERT INTO run (id, student_id, business, week, cash, over) VALUES (?, ?, ?, ?, ?, 0)'
            ).bind(run.id, id, run.business, run.week, run.cash).run();
            return reply({ run, info: BUSINESSES[run.business] });
        }

        // The run in progress, so closing the tab does not lose the game.
        if (path === '/api/run') {
            const row = await env.DB.prepare(
                'SELECT id, business, week, cash, over FROM run WHERE student_id = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(id).first();
            if (!row) return reply({ run: null });
            return reply({
                run: { ...row, over: !!row.over },
                info: BUSINESSES[row.business],
                breakEven: breakEvenUnits(row.business, BUSINESSES[row.business].refPrice),
            });
        }

        // Play one week. The only place the game actually advances.
        if (path === '/api/week' && request.method === 'POST') {
            const body = await readBody(request);
            const row = await env.DB.prepare(
                'SELECT id, business, week, cash, over FROM run WHERE student_id = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(id).first();

            if (!row) return reply({ error: 'start a run first' }, 400);
            if (row.over) return reply({ error: 'this run has finished' }, 409);

            const out = playWeek({ ...row, over: !!row.over }, {
                price: body?.price,
                stock: body?.stock,
            });
            const coins = coinsFor(out.result);

            // The run and the week's record move together: a half-written week
            // would leave a student's cash disagreeing with their own history.
            await env.DB.batch([
                env.DB.prepare('UPDATE run SET week = ?, cash = ?, over = ? WHERE id = ?')
                    .bind(out.run.week, out.run.cash, out.over ? 1 : 0, row.id),
                env.DB.prepare('INSERT INTO event (student_id, kind, payload, points) VALUES (?, ?, ?, ?)')
                    .bind(id, 'week_played', JSON.stringify({
                        run: row.id, week: row.week, event: out.eventKey,
                        price: body?.price, stock: body?.stock, profit: out.result.profit,
                    }).slice(0, 2000), coins),
            ]);

            const sum = await env.DB
                .prepare('SELECT COALESCE(SUM(points), 0) AS points FROM event WHERE student_id = ?')
                .bind(id).first();
            const points = sum?.points ?? 0;
            await env.DB.prepare(
                'UPDATE progress SET points = ?, level = ?, updated_at = datetime(\'now\') WHERE student_id = ?'
            ).bind(points, levelFor(points), id).run();

            return reply({
                week: row.week,
                result: out.result,
                run: out.run,
                over: out.over,
                ending: out.ending,
                coins,
                points,
                level: levelFor(points),
            });
        }

        if (path === '/api/tutor' && request.method === 'POST') {
            const body = await readBody(request);
            const question = String(body?.question ?? '').trim().slice(0, 500);
            if (!question) return reply({ error: 'send {"question":"..."}' }, 400);

            const out = await env.AI.run(TUTOR_MODEL, {
                messages: [
                    { role: 'system', content: SYSTEM },
                    { role: 'user', content: question },
                ],
                max_tokens: 300,
            });
            return reply({ answer: out.response ?? '' });
        }

        return reply({ error: 'not found' }, 404);
    },
};
