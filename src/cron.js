const cron = require('node-cron');
const { Series, Chat, Watchlist } = require('./db');
const { getSeasons, getSeriesData } = require('./api/kinopoisk');
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
            const seasons = await getSeasons(item.kp_id);
            if (!seasons || seasons.length === 0) continue;

            const validSeasons = seasons.filter(s => s.episodes && s.episodes.length > 0);
            if (validSeasons.length === 0) continue;

            const lastS = validSeasons[validSeasons.length - 1];
            const lastE = lastS.episodes[lastS.episodes.length - 1];
            if (!lastE) continue;

            const hasNewSeason = lastS.number > item.last_season;
            const hasNewEpisode = lastS.number === item.last_season && lastE.number > item.last_episode;

            if (!hasNewSeason && !hasNewEpisode) continue;

            console.log(`[Cron] New content for "${item.title}": S${lastS.number}E${lastE.number}`);
            const epName = lastE.name || lastE.enName || 'Без названия';

            const chats = item.Chats || [];
            for (const chat of chats) {
                try {
                    const subscription = chat.Subscription;
                    const notify_type = subscription.notify_type;

                    const episodesLoaded = lastS.episodes ? lastS.episodes.length : 0;
                    const targetCount = lastS.episodesCount || 0;
                    const isSeasonComplete = targetCount > 0 && episodesLoaded >= targetCount;

                    let shouldNotify = false;
                    let msg = '';

                    if (notify_type === 'episode') {
                        shouldNotify = true;
                        msg = `⚡️ Новая серия! <b>${item.title}</b> — Сезон ${lastS.number}, Серия ${lastE.number}: ${epName}`;
                    } else if (notify_type === 'season') {
                        if (isSeasonComplete) {
                            shouldNotify = true;
                            msg = `✅ <b>Весь сезон вышел!</b>\n\n📺 <b>${item.title}</b>\n📦 Сезон ${lastS.number} полностью доступен (${episodesLoaded} сер.).`;
                        }
                    } else if (notify_type === 'first_and_full') {
                        if (lastE.number === 1) {
                            shouldNotify = true;
                            msg = `🆕 <b>Премьера сезона!</b>\n\n📺 <b>${item.title}</b>\n🎞 Сезон ${lastS.number}, Серия 1: ${epName}\n<i>(Вы также получите уведомление, когда сезон выйдет целиком)</i>`;
                        } else if (isSeasonComplete) {
                            shouldNotify = true;
                            msg = `✅ <b>Весь сезон вышел!</b>\n\n📺 <b>${item.title}</b>\n📦 Сезон ${lastS.number} полностью доступен (${episodesLoaded} сер.).`;
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
                last_season: lastS.number,
                last_episode: lastE.number,
                last_episode_name: epName
            });
        } catch (err) {
            console.error(`[Cron] Error checking series ${item.kp_id} ("${item.title}"):`, err.message);
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

    // Group by kp_id to batch API calls (multiple users may watch same movie)
    const byFilm = {};
    for (const entry of entries) {
        if (!byFilm[entry.kp_id]) byFilm[entry.kp_id] = [];
        byFilm[entry.kp_id].push(entry);
    }

    for (const [kp_id, filmEntries] of Object.entries(byFilm)) {
        try {
            const data = await getSeriesData(kp_id);
            if (!data) continue;

            // Extract digital release date from the API response
            const digitalDate = data.premiere?.digital || null;

            // Update stored date if it changed or was previously null
            const firstEntry = filmEntries[0];
            if (digitalDate && firstEntry.premiere_digital !== digitalDate) {
                await Watchlist.update(
                    { premiere_digital: digitalDate },
                    { where: { kp_id } }
                );
            }

            // Check if the digital release date has passed
            if (!digitalDate) {
                console.log(`[Cron] Movie "${firstEntry.title}" (${kp_id}): no digital date yet.`);
                continue;
            }

            const releaseDate = new Date(digitalDate);
            if (isNaN(releaseDate.getTime()) || releaseDate > now) continue;

            // 🎉 Film is released! Notify all users waiting for it
            console.log(`[Cron] Movie "${firstEntry.title}" (${kp_id}) is now available digitally!`);
            const watchLink = getWatchLink(kp_id);
            const formattedDate = formatReleaseDate(digitalDate);

            for (const entry of filmEntries) {
                try {
                    const msg =
                        `🎬 <b>Фильм доступен!</b>\n\n` +
                        `🍿 <b>${entry.title}</b>${entry.year ? ` (${entry.year})` : ''}\n` +
                        `📅 Дата цифрового релиза: <b>${formattedDate}</b>\n\n` +
                        `▶️ <a href="${watchLink}">Смотреть на sspoisk.ru</a>`;

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
            console.error(`[Cron] Error checking watchlist movie ${kp_id}:`, err.message);
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
