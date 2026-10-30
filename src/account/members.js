/**
 * Which chats a signed-in user may open, and what they may do there. The private chat with the
 * bot is the user's own account (its id is the user's id); a group is a shared account of its
 * members. In a group every member changes the list, and only its admins change its settings,
 * as in the bot (src/bot/settings.js). Membership is Telegram's answer, asked each few minutes:
 * a user who leaves a group loses its account soon after.
 */
const { Op } = require('sequelize');
const { Chat } = require('../db');
const { OpError } = require('../chat-ops');
const { lruCache, fetchFresh } = require('../lru');
const { log } = require('../log');

const MEMBER_TTL_MS = 5 * 60 * 1000;
const TITLE_TTL_MS = 60 * 60 * 1000;
// Telegram through a silent proxy held requests for minutes: no page waits for it longer than this
const ASK_MS = 3000;
// After a failure the same question waits this long: reloading the page doesn't ask Telegram again
const FAILED_TTL_MS = 30 * 1000;
// The whole list of a user's groups: what isn't known by then is left out of this answer
const LIST_BUDGET_MS = 5000;
const PARALLEL = 5;
const MAX_GROUPS = 300;

const ADMIN = new Set(['creator', 'administrator']);

let bot = null;
/** The bot whose Telegram connection asks for members and titles (src/admin/index.js). */
const useBot = (instance) => {
    bot = instance;
};

/** Telegram's answer, or an error after ASK_MS. */
function ask(request) {
    let timer;
    const late = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ASK_MS / 1000} s`)), ASK_MS);
    });
    return Promise.race([request, late]).finally(() => clearTimeout(timer));
}

const failed = lruCache({ max: 5000, ttl: FAILED_TTL_MS });
const UNKNOWN = "Telegram isn't answering. Try again in a minute.";

/**
 * A user's place in a group: 'admin', 'member' or 'none'. Telegram not answering is an error,
 * not 'none': it isn't kept, so a moment's 429 doesn't hide the user's groups for minutes, and the
 * account isn't handed out on a guess either.
 */
const members = lruCache({
    max: 5000,
    ttl: MEMBER_TTL_MS,
    fetchMethod: async (key) => {
        const [chatId, userId] = key.split(':');
        if (failed.has(key)) throw new OpError(503, UNKNOWN);
        try {
            const member = await ask(bot.telegram.getChatMember(chatId, Number(userId)));
            if (ADMIN.has(member.status)) return 'admin';
            if (member.status === 'member' || (member.status === 'restricted' && member.is_member)) return 'member';
            return 'none';
        } catch (err) {
            log.warn(`[Account] Membership of ${userId} in ${chatId} unknown: ${err.message}`);
            failed.set(key, true);
            throw new OpError(503, UNKNOWN);
        }
    }
});

const titles = lruCache({
    max: 2000,
    ttl: TITLE_TTL_MS,
    fetchMethod: async (chatId) => {
        try {
            const chat = await ask(bot.telegram.getChat(chatId));
            return chat.title || '';
        } catch {
            return '';
        }
    }
});

const isGroupId = (chatId) => String(chatId).startsWith('-');
// A channel's subscribers are its "members" to Telegram too: channels have no shared account
const GROUP_TYPES = ['group', 'supergroup'];

/**
 * What the user may do in a chat.
 * @returns {Promise<{ edit: boolean, settings: boolean } | null>} null: no access
 */
async function accessTo(userId, chatId) {
    if (String(chatId) === String(userId)) return { edit: true, settings: true };
    if (!isGroupId(chatId)) return null;
    const chat = await Chat.findByPk(chatId, { attributes: ['type'] });
    if (!chat || !GROUP_TYPES.includes(chat.type)) return null;
    const role = await fetchFresh(members, `${chatId}:${userId}`);
    if (role === 'admin') return { edit: true, settings: true };
    if (role === 'member') return { edit: true, settings: false };
    return null;
}

/** `fn` over `items`, a few at a time, until the deadline: what's left after it is skipped. */
async function inBatches(items, fn, deadline) {
    const out = [];
    for (let i = 0; i < items.length && Date.now() < deadline; i += PARALLEL) {
        out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
    }
    return out;
}

/**
 * The accounts a user can open: their own (once they have started the bot), then the groups
 * with the bot that they are in, as far as Telegram answered within LIST_BUDGET_MS.
 * @returns {Promise<{ id: string, type: string, title: string, settings: boolean }[]>}
 */
async function chatsOf(userId) {
    const deadline = Date.now() + LIST_BUDGET_MS;
    const [own, groups] = await Promise.all([
        Chat.findByPk(userId),
        Chat.findAll({
            where: { id: { [Op.lt]: 0 }, type: GROUP_TYPES, bot_status: 'active' },
            attributes: ['id', 'type', 'username'],
            limit: MAX_GROUPS
        })
    ]);
    const list = [];
    if (own) list.push({ id: String(own.id), type: 'private', title: 'My account', settings: true });
    const found = await inBatches(
        groups,
        async (group) => {
            // A group Telegram didn't answer for is left out this time, not an error for the whole list
            const access = await accessTo(userId, group.id).catch(() => null);
            if (!access) return null;
            const title = (await fetchFresh(titles, String(group.id))) || group.username || `Group ${group.id}`;
            return { id: String(group.id), type: group.type, title, settings: access.settings };
        },
        deadline
    );
    return list.concat(found.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title, 'ru')));
}

/** Forgets what Telegram said about a group (a test, or a member who just joined). */
const forget = () => {
    members.clear();
    titles.clear();
    failed.clear();
};

module.exports = { useBot, accessTo, chatsOf, forget };
