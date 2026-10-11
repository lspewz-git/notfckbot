const cron = require('node-cron');
const { Series, Chat, Watchlist } = require('./db');
const { getDetails } = require('./api/tmdb');
const { getWatchLink, isFinishedStatus, escapeHtml, formatRuDate } = require('./constants');

// Guard to prevent parallel cron runs (avoids duplicate notifications)
let isRunning = false;

// ============================================================
// TV Series update check
// ============================================================
// Tell subscribers when a show crosses the running/finished line. Ended <-> Canceled and
// Returning <-> In Production changes are not interesting to users and stay silent.
// Ended/canceled shows are shown in the bot's "Завершённые" archive instead of the active list.
const notifyStatusChange = async (bot, item, oldStatus, newStatus) => {
    // The first status fill (null -> X) is bookkeeping, not news.
    if (!oldStatus || isFinishedStatus(oldStatus) === isFinishedStatus(newStatus)) return;

    const title = escapeHtml(item.title);
    const msg = isFinishedStatus(newStatus)
        ? `${newStatus === 'Canceled' ? '⛔ <b>Сериал отменён</b>' : '🏁 <b>Сериал завершён</b>'}\n\n` +
          `📺 <b>${title}</b> — новых серий не будет.\n\n` +
          'Перенёс его в 📺 Мои подписки → 🗄 Завершённые. Если сериал продлят, я сообщу.'
        : `🎉 <b>Сериал продлили!</b>\n\n📺 <b>${title}</b> снова в активных подписках — ` +
          'уведомления о новых сериях придут как обычно.';

    console.log(`[Cron] Status of "${item.title}": ${oldStatus} -> ${newStatus}, notifying subscribers`);
    for (const chat of item.Chats || []) {
        try {
            await bot.telegram.sendMessage(chat.id, msg, { parse_mode: 'HTML' });
        } catch (err) {
            console.error(`[Cron] Failed to send status update to chat ${chat.id}:`, err.message);
        }
    }
};

const checkSeriesUpdates = async (bot, allSeries) => {
    for (const item of allSeries) {
        try {
            const [mediaType, filmId] = item.tmdb_id.split('_');
            const data = await getDetails(filmId, mediaType);
            if (!data) continue;

            // Store the status first so a failure in the episode step below can't hold up the
            // archive move. The status message is still sent last: a finale often airs in the
            // same check that flips the status to Ended, and "new episode" should come first.
            const oldStatus = item.status;
            const statusChanged = Boolean(data.status) && data.status !== oldStatus;
            if (statusChanged) await item.update({ status: data.status });

            try {
                await notifyNewEpisodes(bot, item, data);
            } catch (err) {
                console.error(`[Cron] Episode check failed for ${item.tmdb_id} ("${item.title}"):`, err.message);
            }

            if (statusChanged) await notifyStatusChange(bot, item, oldStatus, data.status);
        } catch (err) {
            console.error(`[Cron] Error checking series ${item.tmdb_id} ("${item.title}"):`, err.message);
        }
    }
};

/**
 * A season counts as complete only when both hold:
 * - the last aired episode has reached the season's episode count, and
 * - TMDB announces no further episode in that same season.
 * TMDB often lists only the episodes announced so far, so the count alone can
 * say "complete" while more episodes are still scheduled.
 */
const isSeasonComplete = (data, season, episode) => {
    const seasonObj = (data.seasons || []).find((s) => s.season_number === season);
    const total = seasonObj ? seasonObj.episode_count : 0;
    const next = data.next_episode_to_air;
    const moreInSeason = Boolean(next) && next.season_number === season;
    return total > 0 && episode >= total && !moreInSeason;
};

const sendToChat = (bot, item, chatId, msg) =>
    item.poster_url
        ? bot.telegram.sendPhoto(chatId, item.poster_url, { caption: msg, parse_mode: 'HTML' })
        : bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });

const notifyNewEpisodes = async (bot, item, data) => {
    const lastE = data.last_episode_to_air;
    if (!lastE) return; // No episodes aired yet

    const currentSeason = lastE.season_number;
    const currentEpisode = lastE.episode_number;

    const hasNewSeason = currentSeason > item.last_season;
    const hasNewEpisode = currentSeason === item.last_season && currentEpisode > item.last_episode;
    const hasNewContent = hasNewSeason || hasNewEpisode;
    const complete = isSeasonComplete(data, currentSeason, currentEpisode);

    // First check since completed_season existed: take what is already on screen as
    // announced, so old seasons don't suddenly produce "season complete" messages.
    let completedSeason = item.completed_season;
    if (completedSeason === null || completedSeason === undefined) {
        if (hasNewContent) completedSeason = item.last_season;
        else completedSeason = complete ? currentSeason : currentSeason - 1;
        await item.update({ completed_season: completedSeason });
    }

    // Completion is announced once per season, on whichever check first sees it —
    // possibly a later one than the final episode, if TMDB still listed more then.
    const announceComplete = complete && completedSeason < currentSeason;
    if (!hasNewContent && !announceComplete) return;

    console.log(
        `[Cron] "${item.title}": S${currentSeason}E${currentEpisode}` +
            (hasNewContent ? ' new' : '') +
            (announceComplete ? ', season complete' : '')
    );
    const epName = lastE.name || 'Без названия';
    const title = escapeHtml(item.title);
    const safeEpName = escapeHtml(epName);
    const watchLink = getWatchLink(item.title);

    const episodeMsg = `⚡️ Новая серия! <b>${title}</b> — Сезон ${currentSeason}, Серия ${currentEpisode}: ${safeEpName}\n\n▶️ <a href="${watchLink}">Смотреть онлайн</a>`;
    const premiereMsg = `🆕 <b>Премьера сезона!</b>\n\n📺 <b>${title}</b>\n🎞 Сезон ${currentSeason}, Серия 1: ${safeEpName}\n\n▶️ <a href="${watchLink}">Смотреть онлайн</a>\n<i>(Вы также получите уведомление, когда сезон выйдет целиком)</i>`;
    const completeMsg = `✅ <b>Весь сезон вышел!</b>\n\n📺 <b>${title}</b>\n📦 Сезон ${currentSeason} полностью доступен (${currentEpisode} сер.).\n\n▶️ <a href="${watchLink}">Смотреть онлайн</a>`;

    for (const chat of item.Chats || []) {
        try {
            const mode = chat.Subscription.notify_type;
            let msg = null;
            if (mode === 'episode') {
                if (hasNewContent) msg = episodeMsg;
            } else if (mode === 'season') {
                if (announceComplete) msg = completeMsg;
            } else if (mode === 'first_and_full') {
                // A one-episode season is both premiere and finale: one message is enough
                if (hasNewContent && currentEpisode === 1) msg = premiereMsg;
                else if (announceComplete) msg = completeMsg;
            }
            if (msg) await sendToChat(bot, item, chat.id, msg);
        } catch (err) {
            console.error(`[Cron] Failed to notify chat ${chat.id}:`, err.message);
        }
    }

    await item.update({
        last_season: currentSeason,
        last_episode: currentEpisode,
        last_episode_name: epName,
        ...(announceComplete ? { completed_season: currentSeason } : {})
    });
};

// ============================================================
// Watchlist: movie digital release check
// ============================================================
const checkWatchlistReleases = async (bot) => {
    // Load all unnotified watchlist entries with their chat
    const entries = await Watchlist.findAll({
        where: { notified: false },
        include: [{ model: Chat }]
    });

    if (entries.length === 0) return;
    console.log(`[Cron] Checking ${entries.length} watchlist movie(s)...`);

    const now = new Date();

    // Group by tmdb_id to batch API calls (multiple users may watch same movie)
    const byFilm = {};
    for (const entry of entries) {
        if (!byFilm[entry.tmdb_id]) byFilm[entry.tmdb_id] = [];
        byFilm[entry.tmdb_id].push(entry);
    }

    for (const [tmdb_id, filmEntries] of Object.entries(byFilm)) {
        try {
            let [mediaType, filmId] = tmdb_id.split('_');
            if (!filmId) {
                filmId = mediaType;
                mediaType = 'movie'; // Watchlist currently only supports movies
            }
            const data = await getDetails(filmId, mediaType);
            if (!data) continue;

            const firstEntry = filmEntries[0];
            let isReleased = false;
            let displayDate = null;

            if (data.status === 'Released') {
                isReleased = true;
            } else if (data.release_date) {
                const releaseDate = new Date(data.release_date);
                if (!isNaN(releaseDate) && releaseDate <= now) {
                    isReleased = true;
                }
                displayDate = data.release_date;
            }

            if (!isReleased) {
                console.log(`[Cron] Movie "${firstEntry.title}" (${tmdb_id}): not released yet.`);
                continue;
            }

            // 🎉 Film is released! Notify all users waiting for it
            console.log(`[Cron] Movie "${firstEntry.title}" (${tmdb_id}) is now available!`);
            const formattedDate = formatRuDate(displayDate);
            const watchLink = getWatchLink(firstEntry.title);

            for (const entry of filmEntries) {
                try {
                    const directorInfo = data.director_name
                        ? `🎬 Режиссер: <b>${escapeHtml(data.director_name)}</b>\n`
                        : '';
                    const msg =
                        `🎬 <b>Фильм доступен!</b>\n\n` +
                        `🍿 <b>${escapeHtml(entry.title)}</b>${entry.year ? ` (${entry.year})` : ''}\n` +
                        `${directorInfo}` +
                        `📅 Дата релиза: <b>${formattedDate || 'уже вышел'}</b>\n\n` +
                        `▶️ <a href="${watchLink}">Смотреть онлайн</a>`;

                    if (entry.poster_url) {
                        await bot.telegram.sendPhoto(entry.Chat.id, entry.poster_url, {
                            caption: msg,
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.telegram.sendMessage(entry.Chat.id, msg, {
                            parse_mode: 'HTML',
                            disable_web_page_preview: false
                        });
                    }
                } catch (err) {
                    console.error(`[Cron] Failed to notify watchlist chat ${entry.Chat.id}:`, err.message);
                }

                // Mark as notified so we don't send again
                await entry.update({ notified: true });
            }
        } catch (err) {
            console.error(`[Cron] Error checking watchlist movie ${tmdb_id}:`, err.message);
        }
    }
};

// ============================================================
// Main checkUpdates — runs both series and watchlist checks
// ============================================================
const checkUpdates = async (bot) => {
    if (isRunning) {
        console.log('[Cron] Update check already in progress. Skipping.');
        return;
    }
    isRunning = true;
    console.log('[Cron] Running update check...');

    try {
        // Load all series WITH their subscribers in one single query
        const allSeries = await Series.findAll({ include: [{ model: Chat }] });
        await checkSeriesUpdates(bot, allSeries);
        await checkWatchlistReleases(bot);
    } catch (error) {
        console.error('[Cron] Fatal error during update check:', error);
    } finally {
        isRunning = false;
        console.log('[Cron] Update check complete.');
    }
};

const setupCron = (bot) => {
    cron.schedule('0 */3 * * *', () => checkUpdates(bot));
    console.log('[Cron] Scheduled: every 3 hours.');
};

module.exports = { setupCron, checkUpdates };
