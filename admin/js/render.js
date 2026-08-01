/**
 * Skips a rebuild when a poll returns exactly what is already on screen.
 *
 * Without this every table, log and list was thrown away and recreated every
 * 10 seconds — taking any text selection inside it along.
 */

const signatures = {};

export function isUnchanged(key, data) {
    // ?? null so an undefined payload never matches an unset slot
    const signature = JSON.stringify(data ?? null);
    if (signatures[key] === signature) return true;
    signatures[key] = signature;
    return false;
}

/** Call when something other than fresh data replaced the markup. */
export const invalidate = (key) => {
    delete signatures[key];
};
