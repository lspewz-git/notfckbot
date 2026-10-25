/**
 * Whether the bot can still reach each chat, and when each chat last used it (Chat.bot_status,
 * last_seen_at). Three sources: Telegram's own word when a user blocks the bot or a group takes it
 * out (my_chat_member, src/bot/membership.js); a send refused for that reason (src/delivery.js),
 * for what the bot missed while it was down; and any message or button from a chat thought lost,
 * which means it is back. Kept in memory and written with the chat events (src/chat-events.js):
 * every ten minutes, at the end of each update check and before a restart; the Telegram handler
 * writes at once. Each change is also a ChatEvent (bot_off / bot_on) for the chat's history.
 */
const { Chat } = require('./db');
const events = require('./chat-events');
const { log } = require('./log');

/** The statuses of a chat the bot can't reach; the rest is 'active'. */
const LEFT = ['stopped', 'removed', 'deleted'];

// Telegram's refusals that mean the chat is gone for the bot, and how. "Not enough rights" and
// "can't initiate conversation" don't: the chat is still there, the message just can't go
const REASONS = [
    [/bot was blocked by the user/i, 'stopped'],
    [/bot was kicked|bot is not a member/i, 'removed'],
    [/user is deactivated|chat not found|group chat was deactivated|PEER_ID_INVALID/i, 'deleted']
];

// Not yet written, by chat id. changes: the latest status a source gave; seen: the latest use
let changes = new Map();
let seen = new Map();

/** Why a refused send means the chat is gone for the bot (stopped, removed, deleted), or null. */
function leftReason(error) {
    const hit = REASONS.find(([pattern]) => pattern.test(String(error || '')));
    return hit ? hit[1] : null;
}

/** Whether the bot has lost the chat, counting what is not written yet. */
function isLeft(chat) {
    if (!chat) return false;
    const change = changes.get(String(chat.id));
    return LEFT.includes(change ? change.status : chat.bot_status);
}

/**
 * Telegram said so (my_chat_member): written even when the status is unchanged, as the history's
 * record of who added or removed the bot.
 * @param {string | number} chatId
 * @param {string} status active or one of LEFT
 * @param {{ detail: string, at?: Date, userId?: string | number | null, userName?: string | null }} info
 *   detail: started, added, returned / stopped, removed, deleted; userName: who did it, in a group
 */
function noteTelegram(chatId, status, { detail, at = new Date(), userId = null, userName = null }) {
    changes.set(String(chatId), { status, detail, at, userId, userName, sure: true });
}

/** A send refused: the chat is marked only if the reason says it is gone (leftReason). */
function noteSendFailed(chatId, error, at = new Date()) {
    const reason = leftReason(error);
    if (reason) changes.set(String(chatId), { status: reason, detail: reason, at, sure: false });
}

/** A message or button from the chat. */
function noteSeen(chatId, at = new Date()) {
    seen.set(String(chatId), at);
}

/** What one chat's row becomes, and the event to record, or null for nothing to change. */
function planFor(row, change, seenAt) {
    const update = {};
    if (seenAt) update.last_seen_at = seenAt;
    // Use after the bot lost the chat: it is back, whether or not Telegram told us
    const since = row.bot_status_at ? new Date(row.bot_status_at) : null;
    if (!change && seenAt && LEFT.includes(row.bot_status) && (!since || seenAt > since)) {
        change = { status: 'active', detail: 'returned', at: seenAt, sure: false };
    }
    let event = null;
    if (change) {
        const differs = change.status !== row.bot_status;
        if (differs) {
            update.bot_status = change.status;
            update.bot_status_at = change.at;
            update.bot_status_by = change.userName || null;
        }
        if (differs || change.sure) {
            event = {
                kind: change.status === 'active' ? 'bot_on' : 'bot_off',
                detail: change.detail,
                userId: change.userId || null,
                userName: change.userName || null
            };
        }
    }
    return Object.keys(update).length || event ? { update, event, at: change ? change.at : seenAt } : null;
}

/** Writes what was noted; a chat whose write fails is kept for the next time. */
async function flushStatus() {
    if (!changes.size && !seen.size) return;
    const batch = changes;
    const used = seen;
    changes = new Map();
    seen = new Map();
    const keep = (id) => {
        // Newer notes made meanwhile win
        if (batch.has(id) && !changes.has(id)) changes.set(id, batch.get(id));
        if (used.has(id) && !seen.has(id)) seen.set(id, used.get(id));
    };
    const ids = [...new Set([...batch.keys(), ...used.keys()])];
    let rows;
    try {
        rows = await Chat.findAll({ where: { id: ids } });
    } catch (err) {
        log.error(`[Status] Reading ${ids.length} chat(s) failed: ${err.message}`);
        ids.forEach(keep);
        return;
    }
    for (const row of rows) {
        const id = String(row.id);
        const plan = planFor(row, batch.get(id), used.get(id));
        if (!plan) continue;
        try {
            if (Object.keys(plan.update).length) await row.update(plan.update);
            if (plan.event) {
                events.record(id, plan.event, plan.at);
                log.info(`[Status] Chat ${id}: ${plan.event.kind} (${plan.event.detail})`);
            }
        } catch (err) {
            log.error(`[Status] Writing chat ${id} failed: ${err.message}`);
            keep(id);
        }
    }
}

/** A group became a supergroup (src/chat-migration.js): what is noted for it goes under the new id. */
function moveChat(fromId, toId) {
    for (const map of [changes, seen]) {
        if (map.has(String(fromId))) {
            map.set(String(toId), map.get(String(fromId)));
            map.delete(String(fromId));
        }
    }
}

/** Forgets everything not written, for tests. */
function reset() {
    changes = new Map();
    seen = new Map();
}

module.exports = {
    LEFT,
    leftReason,
    isLeft,
    noteTelegram,
    noteSendFailed,
    noteSeen,
    planFor,
    flushStatus,
    moveChat,
    reset
};
