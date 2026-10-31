/**
 * Teacher accounts, class codes and sessions.
 *
 * Everything here is pure or depends only on WebCrypto, so it runs in a
 * Worker and in `node --test` without a database or a network. The Worker
 * holds the SQL; this file holds the rules that are worth being sure about.
 */

/* ── Join codes ──────────────────────────────────────────────────────── */

/**
 * The alphabet a teacher reads aloud to thirty students at once.
 *
 * I/1/L, O/0 and S/5 are all gone. A code is spoken across a classroom and
 * typed by a thirteen-year-old; every ambiguous pair is a support question
 * later. 29 characters remain, so six of them is about 594 million codes —
 * far more than a school will ever need, and short enough to say twice.
 *
 * ponytail: `% alphabet.length` is very slightly biased toward the first few
 * characters. Irrelevant here — the code is a classroom convenience, not a
 * secret, and the database still rejects a collision.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
export const CODE_LENGTH = 6;

/** A join code. `rand` is injectable so a test can make it deterministic. */
export function makeCode(rand = randomBytes) {
    const bytes = rand(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
}

/**
 * What a student typed, turned into what we look up.
 *
 * They will type it lower case, with a space in the middle, or with a dash
 * they invented. No character substitution is needed or attempted: the
 * alphabet above has no ambiguous pairs left in it, so a typed O or 1 is a
 * misreading of something unknowable rather than a fixable confusion.
 */
export function normaliseCode(input) {
    return String(input ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, CODE_LENGTH);
}

/* ── Passwords ───────────────────────────────────────────────────────── */

/**
 * PBKDF2-SHA256, because it is in the platform.
 *
 * Workers have no bcrypt or argon2 without pulling in a dependency, and a
 * hand-rolled hash on a password is worse than either. WebCrypto's PBKDF2 is
 * the honest choice here.
 *
 * THE COUNT IS CAPPED BY THE HOSTING PLAN, NOT BY WHAT IS IDEAL.
 *
 * The Workers free plan allows about 10ms of CPU per request. 100,000
 * iterations measured at ~20ms, so every signup and every login was killed
 * mid-request — the browser saw a dropped connection, not an error. 10,000
 * measures at ~2ms, which leaves room for the rest of the request even if
 * Cloudflare's crypto runs slower than the machine this was measured on.
 *
 * This is below what OWASP recommends for PBKDF2 and it is a deliberate
 * trade: every account still gets its own random salt, so a stolen table
 * cannot be attacked with a rainbow table or cracked once for everybody, and
 * what sits behind a teacher account is a list of pupils' first names.
 *
 * Raising it needs the paid plan (~₹420/month, which the free tier does not
 * cost) — and raising it is safe to do, because the count each password was
 * hashed with is stored beside its salt. Nobody gets locked out by a change.
 */
export const PBKDF2_ITERATIONS = 10_000;

const enc = new TextEncoder();

export function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
}

export const toHex = (bytes) =>
    [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex) =>
    new Uint8Array((String(hex).match(/../g) ?? []).map((h) => parseInt(h, 16)));

export async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
        key, 256,
    );
    return toHex(new Uint8Array(bits));
}

/**
 * Compare two hashes without leaking where they first differ.
 *
 * `a === b` on a string returns as soon as a byte disagrees. The time that
 * takes is measurable over many attempts, and it tells an attacker how much
 * of a guess was right. This always reads both.
 */
export function timingSafeEqual(a, b) {
    const x = String(a), y = String(b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

/**
 * A new password's salt and hash, ready to store.
 *
 * The salt is stored as "<iterations>$<hex>", so the cost each password was
 * hashed with travels with it. Without that, raising PBKDF2_ITERATIONS would
 * silently lock out every account created before the change — the hash would
 * simply stop matching, with no way to tell that from a wrong password.
 */
export async function newPasswordRecord(password) {
    const salt = toHex(randomBytes(16));
    return {
        salt: `${PBKDF2_ITERATIONS}$${salt}`,
        hash: await hashPassword(password, salt, PBKDF2_ITERATIONS),
    };
}

/** Pull the cost and the salt back apart. A bare salt means the default. */
export function splitSalt(stored) {
    const s = String(stored ?? '');
    const at = s.indexOf('$');
    if (at === -1) return { iterations: PBKDF2_ITERATIONS, salt: s };
    const n = Number.parseInt(s.slice(0, at), 10);
    return {
        iterations: Number.isInteger(n) && n > 0 ? n : PBKDF2_ITERATIONS,
        salt: s.slice(at + 1),
    };
}

/** Does this password match what was stored? */
export async function passwordMatches(password, stored, expectedHash) {
    const { iterations, salt } = splitSalt(stored);
    const actual = await hashPassword(password, salt, iterations);
    return timingSafeEqual(actual, expectedHash);
}

/**
 * A password an admin reads down the phone to a locked-out teacher.
 *
 * Same unambiguous alphabet as a join code, in groups of four, because it is
 * spoken aloud before it is ever typed. Three groups is about 10^17
 * possibilities — it is random, not memorable, and it is meant to be changed
 * once the teacher is back in.
 */
export function tempPassword(rand = randomBytes) {
    const bytes = rand(12);
    let out = '';
    for (let i = 0; i < 12; i += 1) {
        if (i && i % 4 === 0) out += '-';
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
}

/**
 * Who is allowed into the TEN staff page.
 *
 * Read from a Worker secret rather than a table, so promoting someone is a
 * deliberate act outside the app and no request can ever grant it. Unset
 * means nobody — an admin page that opens up when its configuration is
 * missing is worse than one that is simply closed.
 */
export function isAdminEmail(email, configured) {
    const list = String(configured ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const who = String(email ?? '').trim().toLowerCase();
    return !!who && list.includes(who);
}

/**
 * The second lock on the staff page.
 *
 * Being signed in as an address on the admin list is the first. This is a
 * separate secret that lives only in the Worker's configuration and is never
 * written to the database — so a stolen `teacher` table, with every hash in
 * it, still cannot produce admin access. Admin can reset any teacher's
 * password, which makes it the one place worth two independent secrets.
 *
 * Unset means nobody, like the address list: a lock that opens when its key
 * is missing is not a lock.
 */
export function adminPassOk(submitted, configured) {
    const want = String(configured ?? '');
    if (want.length < 8) return false;          // unset, or too short to be one
    return timingSafeEqual(String(submitted ?? ''), want);
}

/** Heads can see the whole school; teachers see their own classes. */
export const isHead = (staffRow) => staffRow?.role === 'head';

/* ── What we refuse to accept ────────────────────────────────────────── */

export const MIN_PASSWORD = 8;

/**
 * Validation at the only boundary that matters.
 *
 * Returns a message a teacher can act on, or null when the input is fine.
 * Deliberately not a regex for email: the only test that proves an address
 * works is sending to it, and a stricter pattern rejects real addresses.
 */
export function checkSignup({ email, password, name }) {
    const e = String(email ?? '').trim();
    if (!e || !e.includes('@') || e.length > 254) return 'Enter a valid email address.';
    if (String(password ?? '').length < MIN_PASSWORD) {
        return `Use a password of at least ${MIN_PASSWORD} characters.`;
    }
    if (!String(name ?? '').trim()) return 'Enter your name.';
    return null;
}

/** A student's first name. No surname is asked for, so none is accepted. */
export function cleanFirstName(input) {
    return String(input ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24);
}

/* ── Sessions ────────────────────────────────────────────────────────── */

export const SESSION_DAYS = 30;

export const newToken = () => toHex(randomBytes(32));

/** When a session minted now should stop working. */
export function sessionExpiry(nowMs, days = SESSION_DAYS) {
    return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
}

export const isExpired = (expiresAtIso, nowMs) =>
    !expiresAtIso || Date.parse(expiresAtIso) <= nowMs;

/* ── Reading a class ─────────────────────────────────────────────────── */

/**
 * Turn one student's played weeks into the row a teacher reads.
 *
 * The rule for "needs attention" is deliberately about *behaviour that a
 * teacher can act on in the next lesson*, not about losing. Losing is the
 * point of the game; the two things worth a conversation are a student who
 * priced below cost (they have not understood margin at all) and a student
 * who never moved the price off its default (they are clicking, not
 * deciding).
 */
export function summariseStudent({ id, name, weeks = [], unitCostFor }) {
    const played = weeks.length;
    const prices = weeks.map((w) => Number(w.price)).filter(Number.isFinite);

    const belowCost = weeks.filter((w) => {
        const cost = unitCostFor?.(w.business);
        return Number.isFinite(cost) && Number(w.price) <= cost;
    }).length;

    const distinctPrices = new Set(prices).size;
    const neverAdjusted = played >= 3 && distinctPrices === 1;
    const bankruptcies = weeks.filter((w) => w.bankrupt).length;

    const reasons = [];
    if (belowCost > 0) reasons.push(`priced at or below cost ${belowCost}×`);
    if (neverAdjusted) reasons.push('never changed the price');
    if (bankruptcies >= 2) reasons.push(`went broke ${bankruptcies}×`);

    return {
        id,
        name: name || 'Unnamed',
        weeksPlayed: played,
        lastWeek: played ? Math.max(...weeks.map((w) => Number(w.week) || 0)) : 0,
        belowCost,
        bankruptcies,
        neverAdjusted,
        needsAttention: reasons.length > 0,
        reasons,
    };
}

/**
 * The one line a teacher reads before the lesson starts.
 *
 * "18 of 30 priced below cost in week 1" is worth more than any average,
 * because it names something to say out loud to the whole room.
 */
export function classPatterns(summaries) {
    const total = summaries.length;
    const started = summaries.filter((s) => s.weeksPlayed > 0).length;
    const below = summaries.filter((s) => s.belowCost > 0).length;
    const stuck = summaries.filter((s) => s.neverAdjusted).length;
    const broke = summaries.filter((s) => s.bankruptcies > 0).length;

    const lines = [];
    if (total === 0) return { total, started, lines };
    if (started < total) lines.push(`${total - started} of ${total} have not started yet`);
    if (below) lines.push(`${below} of ${total} priced at or below cost`);
    if (stuck) lines.push(`${stuck} of ${total} never changed their price`);
    if (broke) lines.push(`${broke} of ${total} went broke at least once`);
    if (!lines.length && started) lines.push(`All ${started} are pricing above cost`);
    return { total, started, lines };
}

/** The class as a CSV a school can keep. */
export function toCsv(summaries) {
    const head = ['Name', 'Weeks played', 'Furthest week', 'Priced below cost',
                  'Times broke', 'Never changed price', 'Needs attention'];
    const cell = (v) => {
        const s = String(v ?? '');
        // A name with a comma or a quote would otherwise shift every column
        // after it, which is how a register quietly stops matching the class.
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = summaries.map((s) => [
        s.name, s.weeksPlayed, s.lastWeek, s.belowCost,
        s.bankruptcies, s.neverAdjusted ? 'yes' : 'no', s.needsAttention ? 'yes' : 'no',
    ]);
    return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
