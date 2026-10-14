/**
 * Who may press the bot's inline buttons in a group. Each message the bot sends with buttons
 * remembers who called it up; in a chat set to "owner" (the default) only that person's presses
 * go through, in a chat set to "all" anyone's do. Private chats have one user and are left alone.
 * One place for every button the bot has: search, the subscriptions menu, and any added later.
 */

// "chatId:messageId" -> { userId, at }. In memory: after a restart the owners of earlier
// messages are unknown, and in an "owner" chat their buttons ask to call the menu up again.
const owners = new Map();
const OWNER_TTL_MS = 48 * 60 * 60 * 1000;
const OWNERS_MAX = 5000;

const keyOf = (chatId, messageId) => `${chatId}:${messageId}`;

function recordOwner(chatId, messageId, userId) {
    if (owners.size >= OWNERS_MAX) owners.delete(owners.keys().next().value);
    owners.set(keyOf(chatId, messageId), { userId, at: Date.now() });
}

function ownerOf(chatId, messageId) {
    const hit = owners.get(keyOf(chatId, messageId));
    return hit && Date.now() - hit.at < OWNER_TTL_MS ? hit.userId : null;
}

const isGroup = (chat) => Boolean(chat) && chat.type !== 'private';

// Buttons that check their own rights, or do nothing: open to everyone in every mode
const OPEN_BUTTONS = /^(settings_|held_|cal_|noop$|subs_noop$)/;

const REPLY_METHODS = ['reply', 'replyWithHTML', 'replyWithPhoto', 'replyWithMarkdown', 'replyWithMarkdownV2'];

/**
 * Whether this press may go through, and if not, what to tell the presser.
 * @returns {string | null} null to let it through, else the popup text
 */
function refusal(chat, settings, messageId, userId) {
    if (!isGroup(chat) || !settings || settings.buttons_mode === 'all') return null;
    const owner = ownerOf(chat.id, messageId);
    if (owner === userId) return null;
    if (owner === null) return 'Эти кнопки устарели. Вызовите меню заново — например, 🔍 Поиск или 📺 Мои подписки.';
    return 'Эти кнопки может нажимать только тот, кто их вызвал. Режим меняется в ⚙️ Настройки.';
}

function register(bot) {
    bot.use(async (ctx, next) => {
        // Messages the bot sends in answer to someone in a group are theirs
        if (isGroup(ctx.chat) && ctx.from) {
            const chatId = ctx.chat.id;
            const userId = ctx.from.id;
            for (const method of REPLY_METHODS) {
                const original = ctx[method];
                if (typeof original !== 'function') continue;
                ctx[method] = async (...args) => {
                    const message = await original.apply(ctx, args);
                    if (message && message.message_id) recordOwner(chatId, message.message_id, userId);
                    return message;
                };
            }
        }

        const query = ctx.callbackQuery;
        if (query && query.message && !OPEN_BUTTONS.test(query.data || '')) {
            const text = refusal(ctx.chat, ctx.state && ctx.state.chatData, query.message.message_id, ctx.from.id);
            if (text) return ctx.answerCbQuery(text, { show_alert: true }).catch(() => {});
        }
        return next();
    });
}

module.exports = { register, refusal, recordOwner, ownerOf };
