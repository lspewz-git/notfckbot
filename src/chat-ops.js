/**
 * What can be changed about one chat's list and settings, shared by the panel (src/admin/routes/records.js)
 * and the users' account pages (src/account/). The bot's own buttons keep their handlers.
 */
const { Chat, Series, Subscription, Watchlist } = require('./db');
const tmdb = require('./api/tmdb');
const { ZONES, isHour } = require('./quiet');
const { sentMarkOnEnable } = require('./cron/digests');
const { NOTIFY_LABELS } = require('./constants');
const { z } = require('./admin/validate');
const events = require('./chat-events');
const { recordSettings } = require('./chat-changes');

/** A refusal the caller shows as it is, with its HTTP status. */
class OpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const NOTIFY_TYPES = Object.keys(NOTIFY_LABELS);

/**
 * Subscribes a chat to a series, or changes the mode of its subscription.
 * @param {{ userId?: number | string, userName?: string }} who for the chat's statistics; none from the panel
 */
async function subscribe(chatId, tmdbId, notifyType, who = {}) {
    const fullId = String(tmdbId).startsWith('tv_') ? String(tmdbId) : `tv_${tmdbId}`;
    const chat = await Chat.findByPk(chatId);
    if (!chat) throw new OpError(404, 'Chat not found');

    let series = await Series.findByPk(fullId);
    if (!series) {
        const details = await tmdb.getDetails(fullId.replace('tv_', ''), 'tv');
        // From the latest aired episode, as the bot does: never announce what is already out
        [series] = await Series.findOrCreate({
            where: { tmdb_id: fullId },
            defaults: tmdb.newSeriesFields(details)
        });
    }

    const [subscription, created] = await Subscription.findOrCreate({
        where: { chatId, seriesId: fullId },
        defaults: { notify_type: notifyType || 'episode' }
    });
    if (created) {
        events.record(chatId, {
            kind: 'subscribed',
            detail: subscription.notify_type,
            tmdb_id: fullId,
            title: series.title,
            ...who
        });
    } else if (notifyType && subscription.notify_type !== notifyType) {
        await subscription.update({ notify_type: notifyType });
        events.record(chatId, { kind: 'mode', detail: notifyType, tmdb_id: fullId, title: series.title, ...who });
    }
    return { subscription, created, series };
}

/** @returns {Promise<boolean>} whether there was a subscription to remove */
async function unsubscribe(chatId, seriesId, who = {}) {
    const removed = await Subscription.destroy({ where: { chatId, seriesId } });
    if (removed) {
        const row = await Series.findByPk(seriesId);
        events.record(chatId, { kind: 'unsubscribed', tmdb_id: seriesId, title: row && row.title, ...who });
    }
    return removed > 0;
}

/** Puts a film on a chat's list: one still to come waits for its release, one already out goes to Released. */
async function addFilm(chatId, tmdbId, who = {}) {
    const chat = await Chat.findByPk(chatId);
    if (!chat) throw new OpError(404, 'Chat not found');

    // Rows are stored as "movie_<id>": the request may send either form
    const numericId = String(tmdbId).replace('movie_', '');
    const fullTmdbId = `movie_${numericId}`;
    const rows = await Watchlist.findAll({ where: { chatId, tmdb_id: fullTmdbId } });
    if (rows.some((r) => !r.notified)) throw new OpError(409, 'Film already in watchlist for this chat');

    const details = await tmdb.getDetails(numericId, 'movie');
    let isReleased = details.status === 'Released';
    if (!isReleased && details.release_date) {
        const releaseDate = new Date(details.release_date);
        isReleased = !isNaN(releaseDate.getTime()) && releaseDate <= new Date();
    }
    // A released film is stored straight into Released; one record there is enough
    if (isReleased && rows.length) throw new OpError(409, "Film is already in this chat's Released list");

    const entry = await Watchlist.create({
        chatId,
        tmdb_id: fullTmdbId,
        title: details.title || details.original_title,
        poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
        year: details.release_date ? parseInt(details.release_date.split('-')[0], 10) : null,
        premiere_digital: details.release_date || null,
        ...tmdb.titleFacts(details, 'movie'),
        notified: isReleased // already out: the update check has nothing to announce
    });
    events.record(chatId, { kind: 'film_added', tmdb_id: fullTmdbId, title: entry.title, ...who });
    return { entry, isReleased };
}

/**
 * Removes a film row. With `chatId` only one of that chat's: the account pages pass it, so a user
 * can't remove another chat's film by its id; the panel removes any.
 * @returns {Promise<boolean>}
 */
async function removeFilm(id, { chatId = null, who = {} } = {}) {
    const entry = await Watchlist.findByPk(id);
    if (!entry || (chatId !== null && String(entry.chatId) !== String(chatId))) return false;
    await entry.destroy();
    events.record(entry.chatId, { kind: 'film_removed', tmdb_id: entry.tmdb_id, title: entry.title, ...who });
    return true;
}

// The chat's bot settings, the same ones its ⚙️ Settings screen in Telegram changes
const SETTING_FIELDS = [
    'buttons_mode',
    'menu_enabled',
    'quiet_start',
    'quiet_end',
    'timezone',
    'digest_week',
    'digest_month'
];
const QUIET = 'Quiet hours: two different hours from 0 to 23, or both off';
const quietHour = z.union([z.null(), z.number().refine(isHour)], { error: QUIET }).optional();
const settingsSchema = z
    .object({
        quiet_start: quietHour,
        quiet_end: quietHour,
        timezone: z
            .enum(
                ZONES.map((zone) => zone.id),
                { error: 'Unknown time zone' }
            )
            .optional(),
        digest_week: z.boolean({ error: 'Bad digest_week' }).optional(),
        digest_month: z.boolean({ error: 'Bad digest_month' }).optional(),
        buttons_mode: z.enum(['owner', 'all'], { error: 'Bad buttons_mode' }).optional(),
        menu_enabled: z.boolean({ error: 'Bad menu_enabled' }).optional()
    })
    // Quiet hours: both hours (0–23, not the same) or both null for off
    .refine(
        ({ quiet_start: start, quiet_end: end }) =>
            (start === undefined && end === undefined) ||
            (start === null && end === null) ||
            (isHour(start) && isHour(end) && start !== end),
        { error: QUIET }
    );

/** The settings as the pages show them. */
const settingsOf = (chat) => Object.fromEntries(SETTING_FIELDS.map((field) => [field, chat[field]]));

/**
 * Applies what `settingsSchema` let through; what was left out stays. The change goes to the chat's
 * change log (src/chat-changes.js) with who made it.
 * @param {{ userId?: number | string, userName?: string, source?: string }} who
 * @returns {Promise<{ chat: any, lines: string[] }>} the changes in words, one per setting
 */
async function updateSettings(chatId, body, who = {}) {
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    if (!Object.keys(changes).length) throw new OpError(400, 'Nothing to change');
    const chat = await Chat.findByPk(chatId);
    if (!chat) throw new OpError(404, 'Chat not found');
    const before = settingsOf(chat);
    // A digest turned on starts with the next one due, as in the bot (src/cron/digests.js)
    for (const which of ['week', 'month']) {
        if (changes[`digest_${which}`] && !chat[`digest_${which}`]) {
            changes[`digest_${which}_sent`] = sentMarkOnEnable(which === 'week' ? 'w' : 'm', {
                ...chat.get(),
                ...changes
            });
        }
    }
    await chat.update(changes);
    return { chat, lines: recordSettings(chatId, before, settingsOf(chat), who) };
}

module.exports = {
    OpError,
    NOTIFY_TYPES,
    subscribe,
    unsubscribe,
    addFilm,
    removeFilm,
    settingsSchema,
    settingsOf,
    updateSettings
};
