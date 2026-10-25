/**
 * Whether the bot is still in each chat, as Telegram tells it (my_chat_member): a user blocks or
 * restarts it, a group adds or removes it. Noted in src/bot-status.js and written at once. Also
 * notes every other update's chat as seen, for the panel's "Last active". Registered before the
 * throttle: a user who blocks the bot a moment after pressing a button must still be heard.
 */
const { Chat } = require('../db');
const status = require('../bot-status');
const events = require('../chat-events');

const IN = ['member', 'administrator', 'creator'];
const OUT = ['left', 'kicked'];

/**
 * What a change of the bot's membership means for the chat, or null for one that doesn't matter
 * (made an admin, its rights changed).
 * @returns {{ status: string, detail: string } | null}
 */
function membershipChange(chatType, before, after) {
    const inside = (m) => IN.includes(m.status) || (m.status === 'restricted' && m.is_member);
    if (chatType === 'private') {
        if (after.status === 'kicked') return { status: 'stopped', detail: 'stopped' };
        return inside(after) ? { status: 'active', detail: 'started' } : null;
    }
    if (OUT.includes(after.status) && inside(before)) return { status: 'removed', detail: 'removed' };
    if (inside(after) && !inside(before)) return { status: 'active', detail: 'added' };
    return null;
}

// Telegram's own notes in the chat, not someone using it: the bot itself leaving posts one
const SERVICE = [
    'left_chat_member',
    'new_chat_members',
    'migrate_to_chat_id',
    'migrate_from_chat_id',
    'group_chat_created'
];

/**
 * When the chat used the bot, for this update: a message (by its own time, to the second, as
 * Telegram dates the bot leaving) or a button; null for anything else.
 */
function seenAt(ctx) {
    if (!ctx.chat || !ctx.from) return null;
    if (ctx.callbackQuery) return new Date();
    const message = ctx.message;
    if (!message || SERVICE.some((key) => message[key])) return null;
    return new Date(message.date * 1000);
}

/**
 * The groups marked as having removed the bot, asked again after a start: Telegram's word that it
 * was added back is dropped with the rest of the updates sent while the bot was down. A read, no
 * message goes out. A user who unblocked the bot can't be asked; their next message tells us.
 */
async function recheckRemoved(bot, botId) {
    const removed = await Chat.findAll({ where: { bot_status: 'removed' } });
    for (const chat of removed) {
        try {
            const member = await bot.telegram.getChatMember(chat.id, botId);
            if (IN.includes(member.status) || (member.status === 'restricted' && member.is_member)) {
                status.noteTelegram(chat.id, 'active', { detail: 'returned' });
            }
        } catch {
            // Not a member, or the group is gone: stays as it is
        }
    }
    await status.flushStatus();
}

function register(bot) {
    bot.on('my_chat_member', async (ctx) => {
        const update = ctx.myChatMember;
        const { chat } = update;
        const change = membershipChange(chat.type, update.old_chat_member, update.new_chat_member);
        if (!change) return;
        const actor = events.actor(ctx);
        // A group the bot was just added to has no row yet. Leaving one it keeps nothing for (an old
        // group already moved to its supergroup) makes none: flushStatus() skips a chat with no row
        if (change.status === 'active') {
            const name = chat.title || (chat.username ? `@${chat.username}` : actor.userName || null);
            await Chat.findOrCreate({ where: { id: chat.id }, defaults: { type: chat.type, username: name } });
        }
        // In a private chat the user is the chat: no "by" to name
        const by = chat.type === 'private' ? {} : actor;
        status.noteTelegram(chat.id, change.status, { detail: change.detail, at: new Date(update.date * 1000), ...by });
        await status.flushStatus();
    });

    bot.use((ctx, next) => {
        const seen = seenAt(ctx);
        if (seen) status.noteSeen(ctx.chat.id, seen);
        return next();
    });
}

module.exports = { register, membershipChange, seenAt, recheckRemoved };
