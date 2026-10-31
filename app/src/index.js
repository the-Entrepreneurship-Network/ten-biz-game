import { pointsFor, levelFor } from './score.js';
import {
    playWeek, newRun, coinsFor, businessChoices, WEEKS, EVENTS, offerForWeek,
} from './game.js';
import { breakEvenUnits, BUSINESSES, UPGRADES, effectsOf } from './sim.js';
import {
    makeCode, normaliseCode, CODE_LENGTH, newPasswordRecord, passwordMatches,
    checkSignup, cleanFirstName, newToken, sessionExpiry, isExpired,
    summariseStudent, classPatterns, toCsv,
} from './auth.js';

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
export const PAGES = { '/play': '/play.html', '/teacher': '/teacher.html' };

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

/**
 * The upgrades a run owns.
 *
 * Always loaded with the run, never separately — a week simulated without
 * them silently prices the shop as though nothing had ever been bought.
 */
async function upgradesFor(db, runId) {
    const rows = await db.prepare('SELECT kind FROM upgrade WHERE run_id = ?').bind(runId).all();
    return (rows.results ?? []).map((r) => r.kind);
}

/**
 * Coins earned and coins left.
 *
 * `earned` only ever counts positive events, so buying something cannot drop
 * a student's level — spending is not un-learning. `balance` counts the
 * negatives too, and is what the shop checks.
 */
async function coinsOf(db, studentId) {
    const row = await db.prepare(
        `SELECT COALESCE(SUM(points), 0) AS balance,
                COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0) AS earned
           FROM event WHERE student_id = ?`
    ).bind(studentId).first();
    return { balance: row?.balance ?? 0, earned: row?.earned ?? 0 };
}

async function readBody(request) {
    // A body that is not JSON is the caller's mistake, not a 500.
    try { return await request.json(); } catch (_) { return null; }
}

export default {
    /**
     * Anything that throws below reaches the browser as a 500 with an HTML
     * body. The page does `(await fetch(...)).json()`, which then throws on
     * that body inside a click handler that catches nothing — so the promise
     * never settles and the screen sits on "Thinking…" forever.
     *
     * An API that still answers in JSON when it fails is the whole difference
     * between a visible error and a frozen page.
     */
    async fetch(request, env) {
        try {
            return await handle(request, env);
        } catch (err) {
            if (new URL(request.url).pathname.startsWith('/api/')) {
                return json({ error: String(err?.message || err) }, 500);
            }
            throw err;
        }
    },
};

async function handle(request, env) {
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

        // Teacher routes resolve first and return on their own. They have a
        // separate identity, and a teacher opening a dashboard must not mint
        // a student id — that would put a phantom pupil in their own class.
        if (path.startsWith('/api/teacher') || path.startsWith('/api/class')) {
            return teacherRoutes(request, env, url, path);
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
            // A class is optional on purpose. Playing without one is the free
            // demo, and the demo is how a school sees the product at all.
            const cls = await env.DB.prepare(
                `SELECT c.name, s.name AS student FROM membership m
                   JOIN class c ON c.id = m.class_id
                   JOIN student s ON s.id = m.student_id
                  WHERE m.student_id = ?`
            ).bind(id).first();
            const { balance } = await coinsOf(env.DB, id);
            return reply({
                id, level: row?.level ?? 1, points: row?.points ?? 0, balance,
                className: cls?.name ?? null, name: cls?.student ?? null,
            });
        }

        // A student joins a class with the code their teacher read out. This
        // is the only place a name is ever collected, and it is a first name
        // with nothing attached to it.
        if (path === '/api/join' && request.method === 'POST') {
            const body = await readBody(request);

            const code = normaliseCode(body?.code);
            if (code.length !== CODE_LENGTH) {
                return reply({ error: `A class code is ${CODE_LENGTH} letters and numbers.` }, 400);
            }
            const name = cleanFirstName(body?.name);
            if (!name) return reply({ error: 'Type your first name.' }, 400);

            const cls = await env.DB.prepare('SELECT id, name FROM class WHERE code = ?')
                .bind(code).first();
            if (!cls) return reply({ error: 'No class has that code. Check it with your teacher.' }, 404);

            await env.DB.batch([
                env.DB.prepare('UPDATE student SET name = ? WHERE id = ?').bind(name, id),
                // Re-joining, or moving to another class, replaces the row
                // rather than failing on the primary key.
                env.DB.prepare(
                    `INSERT INTO membership (student_id, class_id) VALUES (?, ?)
                     ON CONFLICT(student_id) DO UPDATE
                     SET class_id = excluded.class_id, joined_at = datetime('now')`
                ).bind(id, cls.id),
            ]);

            return reply({ ok: true, className: cls.name, name });
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
            return reply({
                run: { ...run, upgrades: [] },
                info: BUSINESSES[run.business],
                offer: offerForWeek(run.id, run.week, run.business),
                shop: { upgrades: [], effects: effectsOf([]), catalogue: UPGRADES },
            });
        }

        // The run in progress, so closing the tab does not lose the game.
        if (path === '/api/run') {
            const row = await env.DB.prepare(
                'SELECT id, business, week, cash, over FROM run WHERE student_id = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(id).first();
            if (!row) return reply({ run: null });
            const owned = await upgradesFor(env.DB, row.id);
            const past = await env.DB.prepare(
                `SELECT payload FROM event
                  WHERE student_id = ? AND kind = 'week_played' ORDER BY id`
            ).bind(id).all();
            const history = (past.results ?? [])
                .map((r) => { try { return JSON.parse(r.payload); } catch (_) { return null; } })
                .filter((w) => w && w.run === row.id && Number.isFinite(w.cash))
                .map((w) => ({ week: w.week, cash: w.cash }));
            return reply({
                run: { ...row, over: !!row.over, upgrades: owned },
                info: BUSINESSES[row.business],
                breakEven: breakEvenUnits(row.business, BUSINESSES[row.business].refPrice,
                                          'normal', owned),
                // Unlike the weather, a bulk order is known before you decide.
                // One that arrived after you had bought your stock would not
                // be a decision at all.
                offer: offerForWeek(row.id, row.week, row.business),
                shop: { upgrades: owned, effects: effectsOf(owned), catalogue: UPGRADES },
                history,
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

            const owned = await upgradesFor(env.DB, row.id);
            const out = playWeek({ ...row, over: !!row.over, upgrades: owned }, {
                price: body?.price,
                stock: body?.stock,
                takeOffer: !!body?.takeOffer,
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
                        // Cash, so the chart survives a refresh. Profit alone
                        // cannot be added up into it — stock is paid for in a
                        // different week from the one it sells in.
                        cash: out.result.cashAfter,
                    }).slice(0, 2000), coins),
            ]);

            const { balance, earned } = await coinsOf(env.DB, id);
            await env.DB.prepare(
                'UPDATE progress SET points = ?, level = ?, updated_at = datetime(\'now\') WHERE student_id = ?'
            ).bind(earned, levelFor(earned), id).run();

            return reply({
                week: row.week,
                result: out.result,
                run: { ...out.run, upgrades: owned },
                over: out.over,
                ending: out.ending,
                coins,
                points: earned,
                balance,
                level: levelFor(earned),
                offer: out.over ? null : offerForWeek(row.id, out.run.week, row.business),
            });
        }

        /**
         * Buy an upgrade.
         *
         * Every check happens here and nowhere else: the page can be lied to,
         * and a shop that trusts the browser is a shop where coins are free.
         * The spend is written as an event with negative points so the same
         * SUM that pays coins out also takes them back — the balance cannot
         * drift from the ledger because it IS the ledger.
         */
        if (path === '/api/upgrade' && request.method === 'POST') {
            const body = await readBody(request);
            const kind = String(body?.kind ?? '');
            const item = UPGRADES[kind];
            if (!item) return reply({ error: 'No such upgrade.' }, 400);

            const row = await env.DB.prepare(
                'SELECT id, over FROM run WHERE student_id = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(id).first();
            if (!row) return reply({ error: 'Start a shop first.' }, 400);
            if (row.over) return reply({ error: 'This run has finished.' }, 409);

            const owned = await upgradesFor(env.DB, row.id);
            if (owned.includes(kind)) return reply({ error: 'You already have that.' }, 409);

            const { balance } = await coinsOf(env.DB, id);
            if (balance < item.cost) {
                return reply({ error: `That costs ${item.cost} coins and you have ${balance}.` }, 402);
            }

            // Both rows or neither: an upgrade nobody paid for, or coins taken
            // for nothing, are each worse than the purchase simply failing.
            await env.DB.batch([
                env.DB.prepare('INSERT INTO upgrade (run_id, kind) VALUES (?, ?)').bind(row.id, kind),
                env.DB.prepare(
                    'INSERT INTO event (student_id, kind, payload, points) VALUES (?, ?, ?, ?)'
                ).bind(id, 'upgrade_bought', JSON.stringify({ run: row.id, upgrade: kind }), -item.cost),
            ]);

            const after = await coinsOf(env.DB, id);
            const nowOwned = [...owned, kind];
            return reply({
                ok: true, bought: kind, balance: after.balance,
                upgrades: nowOwned, effects: effectsOf(nowOwned),
            });
        }

        /**
         * Where you stand in your class.
         *
         * Ranked on the best cash any of your shops ended with — the one
         * number a fourteen-year-old reads without explanation.
         *
         * Only the top ten are returned, and there is deliberately no bottom
         * of the table. A public list of who is losing money in a room of
         * thirty teenagers is a punishment, not a lesson; the teacher already
         * sees who is struggling, privately, on their own dashboard. Your own
         * rank comes back whether or not you are in the ten, because being
         * fourteenth is fine and being invisible is not.
         */
        if (path === '/api/leaderboard') {
            const cls = await env.DB.prepare(
                `SELECT c.id, c.name FROM membership m JOIN class c ON c.id = m.class_id
                  WHERE m.student_id = ?`
            ).bind(id).first();
            // Playing without a class is the free demo, and it has no table.
            if (!cls) return reply({ className: null, top: [], you: null });

            const rows = await env.DB.prepare(
                `SELECT r.student_id AS id, s.name, MAX(r.cash) AS best
                   FROM run r
                   JOIN membership m ON m.student_id = r.student_id
                   JOIN student s ON s.id = r.student_id
                  WHERE m.class_id = ? AND r.week > 1
                  GROUP BY r.student_id
                  ORDER BY best DESC`
            ).bind(cls.id).all();

            // ponytail: ranked in JS over one class — thirty rows, not thirty
            // thousand. A window function when a class is a whole school.
            const all = (rows.results ?? []).map((r, i) => ({
                rank: i + 1, name: r.name || 'Unnamed', cash: r.best, you: r.id === id,
            }));
            const top = all.slice(0, 10).map(({ id: _drop, ...rest }) => rest);
            return reply({
                className: cls.name,
                top,
                you: all.find((r) => r.you) ?? null,
                players: all.length,
            });
        }

        if (path === '/api/tutor' && request.method === 'POST') {
            const body = await readBody(request);
            const question = String(body?.question ?? '').trim().slice(0, 500);
            if (!question) return reply({ error: 'send {"question":"..."}' }, 400);

            // Workers AI fails for ordinary reasons — the free daily allowance
            // is spent, the model name is wrong, the request is rate limited.
            // None of those should look to a student like the page is broken,
            // and the model name is named here because that is the one a
            // deploy can actually get wrong.
            let out;
            try {
                out = await env.AI.run(TUTOR_MODEL, {
                    messages: [
                        { role: 'system', content: SYSTEM },
                        { role: 'user', content: question },
                    ],
                    max_tokens: 300,
                });
            } catch (err) {
                return reply({
                    error: `The tutor could not answer (${TUTOR_MODEL}): ${err?.message || err}`,
                }, 503);
            }

            const answer = String(out?.response ?? '').trim();
            if (!answer) return reply({ error: 'The tutor sent back an empty answer. Try again.' }, 502);
            return reply({ answer });
        }

        return reply({ error: 'not found' }, 404);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Teachers, classes and the dashboard.
 *
 * Kept below the game routes because none of it touches the game: a teacher
 * never plays, and a student never sees any of this.
 * ───────────────────────────────────────────────────────────────────────── */

const TEACHER_COOKIE = 'tsid';

function cookie(request, name) {
    const raw = request.headers.get('cookie') || '';
    const hit = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{8,128})(?:;|$)`).exec(raw);
    return hit ? hit[1] : null;
}

const setCookie = (res, name, value, maxAgeSeconds) => {
    res.headers.append('set-cookie',
        `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`);
    return res;
};

/**
 * Who is making this request, if anyone.
 *
 * An expired row is deleted rather than merely rejected, so the table does
 * not grow forever on a free tier with no cleanup job running anywhere.
 */
async function currentTeacher(request, env) {
    const token = cookie(request, TEACHER_COOKIE);
    if (!token) return null;

    const row = await env.DB.prepare(
        `SELECT t.id, t.email, t.name, t.school, s.expires_at
           FROM session s JOIN teacher t ON t.id = s.teacher_id
          WHERE s.token = ?`
    ).bind(token).first();

    if (!row) return null;
    if (isExpired(row.expires_at, Date.now())) {
        await env.DB.prepare('DELETE FROM session WHERE token = ?').bind(token).run();
        return null;
    }
    return { id: row.id, email: row.email, name: row.name, school: row.school, token };
}

async function startSession(env, teacherId) {
    const token = newToken();
    await env.DB.prepare(
        'INSERT INTO session (token, teacher_id, expires_at) VALUES (?, ?, ?)'
    ).bind(token, teacherId, sessionExpiry(Date.now())).run();
    return token;
}

/**
 * A code nobody else holds.
 *
 * The column is UNIQUE, so a collision is an error rather than two classes
 * quietly sharing students. Retrying a handful of times costs nothing and
 * turns a one-in-millions coincidence into a non-event.
 */
async function freshCode(env, attempts = 8) {
    for (let i = 0; i < attempts; i += 1) {
        const code = makeCode();
        const taken = await env.DB.prepare('SELECT 1 FROM class WHERE code = ?').bind(code).first();
        if (!taken) return code;
    }
    throw new Error('Could not allocate a class code. Try again.');
}

async function teacherRoutes(request, env, url, path) {
    const post = request.method === 'POST';
    const say = (body, status = 200) => json(body, status);

    /* ── Signing up ──────────────────────────────────────────────────── */

    if (path === '/api/teacher/signup' && post) {
        const body = await readBody(request);
        const bad = checkSignup(body ?? {});
        if (bad) return say({ error: bad }, 400);

        const email = String(body.email).trim().toLowerCase();
        const exists = await env.DB.prepare('SELECT 1 FROM teacher WHERE email = ?')
            .bind(email).first();
        // A plain message, not a 500 from the UNIQUE constraint. Account
        // enumeration is not a concern here: a school's teachers are not secret.
        if (exists) return say({ error: 'That email already has an account. Sign in instead.' }, 409);

        const { salt, hash } = await newPasswordRecord(body.password);
        const id = newId();
        await env.DB.prepare(
            'INSERT INTO teacher (id, email, name, school, pw_salt, pw_hash) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, email, String(body.name).trim().slice(0, 80),
               String(body.school ?? '').trim().slice(0, 120), salt, hash).run();

        const token = await startSession(env, id);
        return setCookie(say({ ok: true, name: String(body.name).trim() }), TEACHER_COOKIE,
                         token, 60 * 60 * 24 * 30);
    }

    /* ── Signing in ──────────────────────────────────────────────────── */

    if (path === '/api/teacher/login' && post) {
        const body = await readBody(request);
        const email = String(body?.email ?? '').trim().toLowerCase();

        const row = await env.DB.prepare(
            'SELECT id, name, pw_salt, pw_hash FROM teacher WHERE email = ?'
        ).bind(email).first();

        // One message for both "no such email" and "wrong password", and the
        // hash is still computed when the row is missing, so the reply takes
        // about as long either way.
        const ok = row
            ? await passwordMatches(body?.password, row.pw_salt, row.pw_hash)
            : await passwordMatches(body?.password, '00'.repeat(16), 'x'.repeat(64));

        if (!row || !ok) return say({ error: 'Email or password is not right.' }, 401);

        const token = await startSession(env, row.id);
        return setCookie(say({ ok: true, name: row.name }), TEACHER_COOKIE, token, 60 * 60 * 24 * 30);
    }

    if (path === '/api/teacher/logout' && post) {
        const token = cookie(request, TEACHER_COOKIE);
        if (token) await env.DB.prepare('DELETE FROM session WHERE token = ?').bind(token).run();
        return setCookie(say({ ok: true }), TEACHER_COOKIE, '', 0);
    }

    /* ── Everything below needs a signed-in teacher ──────────────────── */

    const me = await currentTeacher(request, env);
    if (!me) return say({ error: 'Sign in first.' }, 401);

    if (path === '/api/teacher/me') {
        const classes = await env.DB.prepare(
            `SELECT c.id, c.name, c.code,
                    (SELECT COUNT(*) FROM membership m WHERE m.class_id = c.id) AS students
               FROM class c WHERE c.teacher_id = ? ORDER BY c.created_at DESC`
        ).bind(me.id).all();
        return say({ teacher: { name: me.name, email: me.email, school: me.school },
                     classes: classes.results ?? [] });
    }

    if (path === '/api/class' && post) {
        const body = await readBody(request);
        const name = String(body?.name ?? '').trim().slice(0, 80);
        if (!name) return say({ error: 'Give the class a name, like "Class 9B".' }, 400);

        const id = newId();
        const code = await freshCode(env);
        await env.DB.prepare(
            'INSERT INTO class (id, teacher_id, name, code) VALUES (?, ?, ?, ?)'
        ).bind(id, me.id, name, code).run();
        return say({ id, name, code, students: 0 });
    }

    /* ── The dashboard ───────────────────────────────────────────────── */

    if (path === '/api/class' || path === '/api/class/csv') {
        const classId = url.searchParams.get('id') || '';

        // The teacher_id in the WHERE clause is the authorisation check. A
        // teacher guessing another class's id gets the same answer as one
        // guessing an id that does not exist.
        const cls = await env.DB.prepare(
            'SELECT id, name, code FROM class WHERE id = ? AND teacher_id = ?'
        ).bind(classId, me.id).first();
        if (!cls) return say({ error: 'No such class.' }, 404);

        const [students, events, runs] = await Promise.all([
            env.DB.prepare(
                `SELECT s.id, s.name FROM membership m
                   JOIN student s ON s.id = m.student_id
                  WHERE m.class_id = ? ORDER BY s.name`
            ).bind(classId).all(),
            env.DB.prepare(
                `SELECT e.student_id, e.payload FROM event e
                   JOIN membership m ON m.student_id = e.student_id
                  WHERE m.class_id = ? AND e.kind = 'week_played'`
            ).bind(classId).all(),
            env.DB.prepare(
                `SELECT r.id, r.student_id, r.business, r.over, r.cash FROM run r
                   JOIN membership m ON m.student_id = r.student_id
                  WHERE m.class_id = ?`
            ).bind(classId).all(),
        ]);

        // Which business each run was, so a price can be judged against the
        // cost of the thing being sold rather than against nothing.
        const businessOf = new Map((runs.results ?? []).map((r) => [r.id, r.business]));
        const brokeRuns = new Set(
            (runs.results ?? []).filter((r) => r.over && r.cash < 0).map((r) => r.id));

        const weeksByStudent = new Map();
        for (const row of events.results ?? []) {
            let payload;
            try { payload = JSON.parse(row.payload); } catch (_) { continue; }
            const list = weeksByStudent.get(row.student_id) ?? [];
            list.push({
                week: payload.week,
                price: payload.price,
                profit: payload.profit,
                business: businessOf.get(payload.run),
                bankrupt: brokeRuns.has(payload.run) && payload.week != null,
            });
            weeksByStudent.set(row.student_id, list);
        }

        const unitCostFor = (key) => BUSINESSES[key]?.unitCost;
        const summaries = (students.results ?? []).map((s) => summariseStudent({
            id: s.id, name: s.name, weeks: weeksByStudent.get(s.id) ?? [], unitCostFor,
        }));

        if (path === '/api/class/csv') {
            return new Response(toCsv(summaries), {
                headers: {
                    'content-type': 'text/csv; charset=utf-8',
                    'content-disposition':
                        `attachment; filename="${cls.name.replace(/[^\w -]/g, '')} results.csv"`,
                },
            });
        }

        return say({
            class: cls,
            students: summaries,
            attention: summaries.filter((s) => s.needsAttention),
            patterns: classPatterns(summaries),
        });
    }

    return say({ error: 'not found' }, 404);
}
