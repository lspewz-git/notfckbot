/**
 * Wrong passwords for the system account, counted across every address. The route's limit is per
 * address on purpose (a login name alone must not lock its owner out: routes.js), so guessing from
 * many addresses, or slowly from one, is never stopped: the people who run the bot hear of it
 * instead (the "system_signin" alert). Nobody is locked out here either.
 */
const alerts = require('../alerts');
const { placeLine } = require('./devices');
const { escapeHtml } = require('../constants');
const { lruCache } = require('../lru');

// One address gets 5 tries in 15 minutes: ten in an hour is two rounds from it, or several addresses
const WINDOW_MS = 60 * 60 * 1000;
const THRESHOLD = 10;

// Each wrong password of the last hour: a number → the browser that sent it
const misses = lruCache({ max: 1000, ttl: WINDOW_MS });
let sequence = 0;

/** Forgets what was counted: for tests. */
function reset() {
    misses.clear();
    sequence = 0;
}

/**
 * A wrong password for the system account, from this browser (devices.clientOf, or null).
 * @returns {Promise<object | null>} what the alert did, when this miss was the one that set it off
 */
async function systemMiss(device = null, now = Date.now()) {
    misses.set(++sequence, device || {});
    misses.purgeStale();
    if (misses.size < THRESHOLD) return null;
    const count = misses.size;
    const addresses = new Set([...misses.values()].map((d) => d.ip).filter(Boolean)).size;
    const from = placeLine(device);
    const result = await alerts.once(
        'system_signin',
        () =>
            `🔴 <b>Подбор пароля системной учётки</b>\nНеверных паролей за час: ${count}` +
            (addresses ? `\nАдресов: ${addresses}${from ? `, последний: ${escapeHtml(from)}` : ''}` : '') +
            '\nВход не заблокирован. Если это не вы, смените пароль: Settings → Bot → Panel access.',
        // Each hour of guessing is news of its own
        { now: new Date(now), fingerprint: String(Math.floor(now / WINDOW_MS)) }
    );
    // Told (or nobody asked to be): counted again from nothing, the next alert takes ten more. One
    // that didn't get out, or was left out as this hour's second, keeps the count for the next miss
    if (result && (result.sent || !result.wanted)) misses.clear();
    return result;
}

module.exports = { systemMiss, reset, THRESHOLD, WINDOW_MS };
