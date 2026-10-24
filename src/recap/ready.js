/**
 * Which chats' recap cards are drawn and up to date, for the panel's Ready cards and for drawing
 * ahead of a scheduled sending: a chat's kept set matches when its fingerprint is the one its
 * figures give now.
 */
const { Chat, Subscription, Watchlist } = require('../db');
const backgrounds = require('./backgrounds');
const store = require('./store');
const render = require('./render');

/** Every chat that has something to show (or a kept set), with the sets kept for the year. */
async function recapChats(year) {
    const [chats, subs, films, sets] = await Promise.all([
        Chat.findAll({ attributes: ['id', 'username', 'type'], raw: true }),
        Subscription.findAll({ attributes: ['chatId'], group: ['chatId'], raw: true }),
        Watchlist.findAll({ attributes: ['chatId'], group: ['chatId'], raw: true }),
        store.listSets(year)
    ]);
    const wanted = new Set([...subs, ...films, ...sets].map((r) => String(r.chatId)));
    return { chats: chats.filter((c) => wanted.has(String(c.id))), sets };
}

/**
 * Each chat with its state for the year: 'ready' (kept and up to date), 'old' (kept, out of
 * date) or 'none', and its kept set. One chat at a time: each asks the database for its year.
 */
async function readiness(year) {
    const { chats, sets } = await recapChats(year);
    const kept = new Map(sets.map((s) => [s.chatId, s]));
    const looks = await backgrounds.cardLooks();
    const rows = [];
    for (const chat of chats) {
        const id = String(chat.id);
        const set = kept.get(id) || null;
        let state = 'none';
        if (set) {
            const inputs = await render.recapInputs(id, year, { looks });
            state = inputs && inputs.hash === set.hash ? 'ready' : 'old';
        }
        rows.push({ chat, id, set, state });
    }
    return rows;
}

/** The chats whose cards for the year are not drawn or out of date. */
async function toDraw(year) {
    return (await readiness(year)).filter((r) => r.state !== 'ready').map((r) => r.id);
}

module.exports = { readiness, toDraw };
