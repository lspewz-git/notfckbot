/**
 * Which parts of the bot a chat uses, for its statistics in the panel (src/chat-events.js). Only
 * what opens something counts: a command, a menu button, a search, a card, a calendar; paging
 * through a list or a step inside a screen doesn't.
 */
const events = require('../chat-events');
const { getState } = require('./state');

const COMMANDS = {
    start: 'start',
    help: 'help',
    search: 'search',
    subs: 'subs',
    week: 'calendar',
    history: 'history',
    settings: 'settings'
};
const BUTTONS = {
    '🔍 Поиск': 'search',
    '📺 Мои подписки': 'subs',
    'ℹ️ Помощь': 'help',
    '❓ Помощь': 'help',
    '⚙️ Настройки': 'settings'
};
// Inline buttons: the first that matches names the part
const ACTIONS = [
    [/^(?:card|sub)_(?:movie|tv)_\d+$/, 'card'],
    [/^subs_[sm]_/, 'card'],
    [/^cal_[wm]_/, 'calendar'],
    [/^hist_\d/, 'history'],
    [/^held_\d/, 'held'],
    [/^subs_o$/, 'subs']
];

/** The part of the bot an update opens, or null. */
function featureOf(ctx) {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (data) {
        const hit = ACTIONS.find(([pattern]) => pattern.test(data));
        return hit ? hit[1] : null;
    }
    const text = ctx.message && ctx.message.text;
    if (!text) return null;
    if (text.startsWith('/')) {
        // "/week@NotFckBot 2" -> week
        const command = text.slice(1).split(/[\s@]/)[0].toLowerCase();
        return COMMANDS[command] || null;
    }
    if (BUTTONS[text]) return BUTTONS[text];
    return getState(ctx).state === 'waiting_for_search' ? 'query' : null;
}

function register(bot) {
    bot.use((ctx, next) => {
        const feature = ctx.chat && featureOf(ctx);
        if (feature) events.record(ctx.chat.id, { kind: 'used', detail: feature, ...events.actor(ctx) });
        return next();
    });
}

module.exports = { register, featureOf };
