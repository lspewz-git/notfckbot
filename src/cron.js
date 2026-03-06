const cron = require('node-cron');
const { Series, Chat, Watchlist } = require('./db');
const { getDetails } = require('./api/tmdb');
const { NOTIFY_LABELS, getWatchLink } = require('./constants');

// Guard to prevent parallel cron runs (avoids duplicate notifications)
let isRunning = false;

// ============================================================
// Helper: Format digital release date nicely
// ============================================================
const formatReleaseDate = (isoString) => {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};

// ============================================================
// TV Series update check
// ============================================================
const checkSeriesUpdates = async (bot, allSeries) => {
    for (const item of allSeries) {
        try {
            const [mediaType, filmId] = item.tmdb_id.split('_');
            const data = await getDetails(filmId, mediaType);
            if (!data) continue;

            const lastE = data.last_episode_to_air;
            if (!lastE) continue; // No episodes aired yet

            const currentSeason = lastE.season_number;
            const currentEpisode = lastE.episode_number;

            const hasNewSeason = currentSeason > item.last_season;
            const hasNewEpisode = currentSeason === item.last_season && currentEpisode > item.last_episode;

            if (!hasNewSeason && !hasNewEpisode) continue;

            console.log(`[Cron] New content for "${item.title}": S${currentSeason}E${currentEpisode}`);
            const epName = lastE.name || 'Без названия';

            const seasonObj = (data.seasons || []).find(s => s.season_number === currentSeason);
            const targetCount = seasonObj ? seasonObj.episode_count : 0;
            const isSeasonComplete = targetCount > 0 && currentEpisode >= targetCount;

            const chats = item.Chats || [];
            for (const chat of chats) {
                try {
                    const subscription = chat.Subscription;
                    const notify_type = subscription.notify_type;

                    let shouldNotify = false;
                    let msg = '';

                    const watchLink = getWatchLink(item.title);

                    if (notify_type === 'episode') {
                        shouldNotify = true;
                        msg = `⚡️ Новая серия! <b>${item.title}</b> — Сезон ${currentSeason}, Серия ${currentEpisode}: ${epName}\n\n▶️ <a href="${watchLink}">Смотреть онлайн</a>`;
                    } else if (notify_type === 'season') {
                        if (isSeasonComplete) {
                            shouldNotify = true;
                            msg = `✅ <b>Весь сезон вышел!</b>\n\n📺 <b>${item.title}</b>\n📦 Сезон ${currentSeason} полностью доступен (${currentEpisode} сер.).`;
                        }
                    } else if (notify_type === 'first_and_full') {
                        if (currentEpisode === 1) {
                            shouldNotify = true;
                            msg = `🆕 <b>Премьера сезона!</b>\n\n📺 <b>${item.title}</b>\n🎞 Сезон ${currentSeason}, Серия 1: ${epName}\n\n▶️ <a href="${watchLink}">Смотреть онлайн</a>\n<i>(Вы также получите уведомление, когда сезон выйдет целиком)</i>`;
                        } else if (isSeasonComplete) {
                            shouldNotify = true;
                            msg = `✅ <b>Весь сезон вышел!</b>\n\n📺 <b>${item.title}</b>\n📦 Сезон ${currentSeason} полностью доступен (${currentEpisode} сер.).`;
                        }
                    }

                    if (shouldNotify) {
                        if (item.poster_url) {
                            await bot.telegram.sendPhoto(chat.id, item.poster_url, { caption: msg, parse_mode: 'HTML' });
                        } else {
                            await bot.telegram.sendMessage(chat.id, msg, { parse_mode: 'HTML' });
                        }
                    }
                } catch (err) {
                    console.error(`[Cron] Failed to notify chat ${chat.id}:`, err.message);
                }
            }

            // Update series state in DB
            await item.update({
                last_season: currentSeason,
                last_episode: currentEpisode,
                last_episode_name: epName
            });
        } catch (err) {
            console.error(`[Cron] Error checking series ${item.tmdb_id} ("${item.title}"):`, err.message);
        }
    }
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
            const [mediaType, filmId] = tmdb_id.split('_');
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
            const formattedDate = formatReleaseDate(displayDate);
            const watchLink = getWatchLink(firstEntry.title);

            for (const entry of filmEntries) {
                try {
                    const msg =
                        `🎬 <b>Фильм доступен!</b>\n\n` +
                        `🍿 <b>${entry.title}</b>${entry.year ? ` (${entry.year})` : ''}\n` +
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
