/**
 * What can be changed about one chat's list and settings, shared by the panel (src/admin/routes/records.js)
 * and the users' account pages (src/account/). The bot's handlers use the same writes.
 */
const { Chat, Series, Subscription, Watchlist } = require('./db');
const tmdb = require('./api/tmdb');
const { withTvmazeQuick } = require('./episode-times');
const { ZONES, isHour } = require('./quiet');
const { sentMarkOnEnable } = require('./cron/digests');
// The update check's own rule, so a film added now is filed exactly as the check would announce it
const { isReleased: filmIsReleased, isOnline, storedDates, RELEASE_RULE_VERSION } = require('./film-release');
const kinopoisk = require('./api/kinopoisk');
const { todayIn } = require('./calendar');
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
// The only shapes a stored title id takes, whoever asks (the bot's buttons, the panel, the account pages)
const SERIES_ID = /^tv_[1-9]\d{0,9}$/;
const FILM_ID = /^movie_[1-9]\d{0,9}$/;

/**
 * Subscribes a chat to a series, or changes the mode of its subscription.
 * @param {{ userId?: number | string, userName?: string }} who for the chat's statistics; none from the panel
 */
async function subscribe(chatId, tmdbId, notifyType, who = {}, details = null) {
    const fullId = String(tmdbId).startsWith('tv_') ? String(tmdbId) : `tv_${tmdbId}`;
    // One row per series: "tv_1_2" would be a second row for series 1 that the update check asks TMDB about
    if (!SERIES_ID.test(fullId)) throw new OpError(400, 'Bad series id');
    const chat = await Chat.findByPk(chatId);
    if (!chat) throw new OpError(404, 'Chat not found');

    let series = await Series.findByPk(fullId);
    if (!series) {
        details ||= await tmdb.getDetails(fullId.replace('tv_', ''), 'tv');
        // From the latest aired episode, as the bot does: never announce what is already out. By
        // TVmaze's times like the update check, waiting for TVmaze a few seconds at most
        [series] = await Series.findOrCreate({
            where: { tmdb_id: fullId },
            defaults: tmdb.newSeriesFields(await withTvmazeQuick(details))
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
    } else if (notifyType) await setSubscriptionMode(subscription, series, notifyType, who);
    return { subscription, created, series };
}

/** Changes an existing subscription only; a stale bot button must never recreate a deleted one. */
async function setSubscriptionMode(subscription, series, notifyType, who = {}) {
    if (subscription.notify_type === notifyType) return;
    await subscription.update({ notify_type: notifyType });
    events.record(subscription.chatId, {
        kind: 'mode',
        detail: notifyType,
        tmdb_id: series.tmdb_id,
        title: series.title,
        ...who
    });
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
async function addFilm(chatId, tmdbId, who = {}, { details = null, waitingOnly = false } = {}) {
    // Rows are stored as "movie_<id>": the request may send either form
    const numericId = String(tmdbId).replace('movie_', '');
    const fullTmdbId = `movie_${numericId}`;
    if (!FILM_ID.test(fullTmdbId)) throw new OpError(400, 'Bad film id');
    const chat = await Chat.findByPk(chatId);
    if (!chat) throw new OpError(404, 'Chat not found');

    // The bot's waiting-list action keeps its findOrCreate semantics, even for an old card.
    const rows = waitingOnly ? [] : await Watchlist.findAll({ where: { chatId, tmdb_id: fullTmdbId } });
    if (rows.some((r) => !r.notified)) throw new OpError(409, 'Film already in watchlist for this chat');

    details ||= await tmdb.getDetails(numericId, 'movie');
    // Russia's dates count too, as in the update check: a quick lookup (3 s at most, never throws)
    const { ru } = await kinopoisk.kinopoiskQuick(fullTmdbId, details.imdb_id);
    const today = todayIn(chat.timezone);
    const isReleased = filmIsReleased(details, ru, today);
    // A released film is stored straight into Released; one record there is enough
    if (isReleased && rows.length) throw new OpError(409, "Film is already in this chat's Released list");

    const fields = {
        title: details.title || details.original_title || 'Без названия',
        poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
        year: details.release_date ? parseInt(details.release_date.split('-')[0], 10) : null,
        ...tmdb.titleFacts(details, 'movie'),
        // What the lookup found; the update check asks Kinopoisk again on its next run
        ru_premiere: ru.premiere || null,
        ru_digital: ru.digital || null,
        ru_services: ru.services && ru.services.length ? ru.services.join(', ') : null,
        ...storedDates(details, ru),
        notified: waitingOnly ? false : isReleased,
        digital_notified: isOnline(details, ru, today),
        release_rule_version: RELEASE_RULE_VERSION
    };
    const [entry, created] = waitingOnly
        ? await Watchlist.findOrCreate({ where: { chatId, tmdb_id: fullTmdbId, notified: false }, defaults: fields })
        : [await Watchlist.create({ chatId, tmdb_id: fullTmdbId, ...fields }), true];
    if (created) events.record(chatId, { kind: 'film_added', tmdb_id: fullTmdbId, title: entry.title, ...who });
    return { entry, isReleased, created };
}

/**
 * Removes a film row. With `chatId` only one of that chat's: the account pages pass it, so a user
 * can't remove another chat's film by its id; the panel removes any. Account Unfollow passes
 * `allForTitle` so an old notified row cannot hide a newer waiting row of the same film.
 * @returns {Promise<boolean>}
 */
async function removeFilm(id, { chatId = null, who = {}, allForTitle = false } = {}) {
    const entry = await Watchlist.findByPk(id);
    if (!entry || (chatId !== null && String(entry.chatId) !== String(chatId))) return false;
    if (allForTitle) await Watchlist.destroy({ where: { chatId: entry.chatId, tmdb_id: entry.tmdb_id } });
    else await entry.destroy();
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
    'digest_month',
    'notify_digital'
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
        notify_digital: z.boolean({ error: 'Bad notify_digital' }).optional(),
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
async function updateSettings(chatId, body, who = {}, chat = null) {
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    if (!Object.keys(changes).length) throw new OpError(400, 'Nothing to change');
    // Bot middleware already loaded this row; update it in place for the next view.
    chat ||= await Chat.findByPk(chatId);
    if (!chat) throw new OpError(404, 'Chat not found');
    const before = settingsOf(chat);
    if (changes.notify_digital === true && !chat.notify_digital) {
        changes.digital_since = todayIn(changes.timezone || chat.timezone);
    } else if (changes.notify_digital === false) changes.digital_since = null;
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
    setSubscriptionMode,
    unsubscribe,
    addFilm,
    removeFilm,
    settingsSchema,
    settingsOf,
    updateSettings
};
