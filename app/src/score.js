/**
 * Points and levels.
 *
 * Kept pure and separate from the Worker so it can be tested without a
 * network, a database or Cloudflare. The game design is NOT encoded here —
 * `kind` is whatever the game loop decides to call an action, and unknown
 * kinds score zero rather than throwing, so adding a new mechanic never
 * breaks a student's session mid-game.
 */

// ponytail: flat table, not a rules engine. Move to D1 when a teacher needs
// to change scoring without a deploy.
export const POINTS = {
    lesson_done:   10,
    quiz_correct:  20,
    quiz_wrong:     0,
    idea_pitched:  30,
    day_survived:  15,
};

export const PER_LEVEL = 100;

export function pointsFor(kind) {
    return Object.prototype.hasOwnProperty.call(POINTS, kind) ? POINTS[kind] : 0;
}

/** Levels start at 1 and never go down, so a correction cannot demote a child. */
export function levelFor(points) {
    const n = Number(points);
    if (!Number.isFinite(n) || n < 0) return 1;
    return 1 + Math.floor(n / PER_LEVEL);
}
