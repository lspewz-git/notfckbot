/**
 * Records currently on screen, keyed for lookup.
 *
 * The action menus read rows from here by id instead of having names and
 * titles interpolated into markup attributes.
 */

export const chatsById = new Map();
export const subsByKey = new Map();

export const subKey = (chatId, seriesId) => `${chatId}|${seriesId}`;

/** Maps are mutated in place — an imported binding cannot be reassigned. */
export function refill(map, entries) {
    map.clear();
    entries.forEach(([key, value]) => map.set(key, value));
}
