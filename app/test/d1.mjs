/**
 * A real SQLite database wearing D1's interface.
 *
 * node:sqlite is in the standard library, so the teacher routes can run
 * against actual SQL: the joins, the UNIQUE constraint on a class code, the
 * ON CONFLICT when a student re-joins. A hand-written fake would only ever
 * confirm what I assumed while writing the fake.
 *
 * ponytail: batch() runs the statements in order but not in a transaction,
 * which D1 does. Nothing here tests a mid-batch failure, so that difference
 * does not matter yet — if it ever does, wrap it in BEGIN/COMMIT.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

export function freshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);                    // the file that ships — not a copy
    return wrap(db);
}

function wrap(db) {
    const bound = (sql, args) => ({
        sql,
        args,
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => db.prepare(sql).run(...args),
    });

    return {
        prepare: (sql) => ({ ...bound(sql, []), bind: (...args) => bound(sql, args) }),
        batch: async (list) => list.map((s) => db.prepare(s.sql).run(...s.args)),
        /** For a test that wants to look at the tables directly. */
        q: (sql, ...args) => db.prepare(sql).all(...args),
    };
}

/**
 * A browser, more or less: it keeps the cookies the Worker sets.
 *
 * Signup and login hand back a session cookie, and every route after them
 * depends on it being sent again. A client that forgets cookies would make
 * every authorisation test pass for the wrong reason.
 */
export function client(worker, env) {
    const jar = new Map();

    return {
        jar,
        async go(path, body, method) {
            const headers = { 'content-type': 'application/json' };
            if (jar.size) {
                headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
            }
            const res = await worker.fetch(new Request('https://example.com' + path, {
                method: method || (body ? 'POST' : 'GET'),
                headers,
                body: body ? JSON.stringify(body) : undefined,
            }), env);

            for (const line of res.headers.getSetCookie?.() ?? []) {
                const [pair] = line.split(';');
                const i = pair.indexOf('=');
                const [k, v] = [pair.slice(0, i).trim(), pair.slice(i + 1)];
                if (v) jar.set(k, v); else jar.delete(k);
            }
            return res;
        },
    };
}
