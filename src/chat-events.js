/**
 * Records what happens in each chat (ChatEvent) for its statistics. Like the day counts
 * (src/stats-log.js), kept in memory and written in one go at the end of each update check, every
 * ten minutes and before a restart: neither a notification nor a button waits on the database.
 */
const { ChatEvent } = require('./db');
const { log } = require('./log');

// The database down for hours shouldn't eat the memory: past this the oldest go
const MAX_PENDING = 5000;
const FIELDS = ['kind', 'detail', 'outcome', 'tmdb_id', 'title', 'season', 'episode', 'userId', 'userName'];

let pending = [];

/**
 * Notes an event for a chat.
 * @param {string | number} chatId
 * @param {{ kind: string, detail?: string | null, outcome?: string | null, tmdb_id?: string | null,
 *   title?: string | null, season?: number | null, episode?: number | null,
 *   userId?: string | number | null, userName?: string | null }} event
 */
function record(chatId, event, now = new Date()) {
    if (chatId === null || chatId === undefined || !event || !event.kind) return;
    const row = { chatId, createdAt: now };
    for (const field of FIELDS) row[field] = event[field] ?? null;
    if (row.title) row.title = String(row.title).slice(0, 255);
    if (row.userName) row.userName = String(row.userName).slice(0, 255);
    pending.push(row);
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
}

/** Who did it, from a bot update: in a group, the member who pressed the button. */
function actor(ctx) {
    const from = ctx && ctx.from;
    if (!from) return {};
    const name = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
    return { userId: from.id, userName: name || null };
}

/** The events not yet written, for tests. */
const unwritten = () => pending.map((row) => ({ ...row }));

/** Writes what was recorded; on a failure keeps it for the next time. */
async function flushEvents() {
    // First the chats' statuses (src/bot-status.js): each change adds an event to this batch
    await require('./bot-status').flushStatus();
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
        await ChatEvent.bulkCreate(batch);
    } catch (err) {
        log.error(`[Events] Writing ${batch.length} chat event(s) failed: ${err.message}`);
        pending = batch.concat(pending).slice(-MAX_PENDING);
    }
}

/** A group became a supergroup (src/chat-migration.js): its events not written yet go under the new id. */
function moveChat(fromId, toId) {
    for (const row of pending) if (String(row.chatId) === String(fromId)) row.chatId = toId;
}

module.exports = { record, actor, flushEvents, unwritten, moveChat };
