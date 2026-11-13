/** The series half of the update check: new episodes, finished seasons, status changes. */
const { getDetails, nextEpisodeFields, titleFacts } = require('../api/tmdb');
const { ensureKinopoiskId } = require('../api/kinopoisk');
const { isFinishedStatus, formatWatchLinks } = require('../constants');
const { buildSeriesMessages, buildStatusMessage, heldLine } = require('./messages');
const { tally } = require('./status');
const { notify } = require('./outbox');
const { ensureReleaseSeasons } = require('./release-seasons');
const { ensureAiredEpisodes, seasonsToRescan } = require('./aired-episodes');
const { log } = require('../log');
const { warmSeasons, seasonsAlong } = require('../calendar');
const tvmaze = require('../api/tvmaze');
const { withTvmaze } = require('../episode-times');

// Tell subscribers when a show crosses the running/finished line. Ended <-> Canceled and
// Returning <-> In Production changes are not interesting to users and stay silent.
// Ended/canceled shows are shown in the bot's "Завершённые" archive instead of the active list.
const notifyStatusChange = async (bot, item, oldStatus, newStatus) => {
    // The first status fill (null -> X) is bookkeeping, not news.
    if (!oldStatus || isFinishedStatus(oldStatus) === isFinishedStatus(newStatus)) return;

    const msg = buildStatusMessage(item.title, newStatus);

    log.info(`[Cron] Status of "${item.title}": ${oldStatus} -> ${newStatus}, notifying subscribers`);
    for (const chat of item.Chats || []) {
        await notify(bot, chat.id, msg, {
            about: `${item.title}: ${newStatus}`,
            event: { detail: 'status', tmdb_id: item.tmdb_id, title: item.title },
            ...heldLine({ kind: 'status', title: item.title, status: newStatus })
        });
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
    // season_continues: TVmaze has a further episode of it that TMDB doesn't list yet (withTvmaze())
    const moreInSeason = (Boolean(next) && next.season_number === season) || data.season_continues === season;
    return total > 0 && episode >= total && !moreInSeason;
};

const notifyNewEpisodes = async (bot, item, data) => {
    const lastE = data.last_episode_to_air;
    if (!lastE) return; // No episodes aired yet

    const currentSeason = lastE.season_number;
    const currentEpisode = lastE.episode_number;

    // Behind the row: it moved on by TVmaze's times and this check has only TMDB's (TVmaze not
    // answering after a restart). Nothing is new, and writing this episode would move the row
    // back and announce the later one a second time.
    const behind =
        currentSeason < item.last_season || (currentSeason === item.last_season && currentEpisode < item.last_episode);
    if (behind) return;

    const hasNewSeason = currentSeason > item.last_season;
    const hasNewEpisode = currentSeason === item.last_season && currentEpisode > item.last_episode;
    const hasNewContent = hasNewSeason || hasNewEpisode;
    const complete = isSeasonComplete(data, currentSeason, currentEpisode);

    // First check since completed_season existed: take what is already on screen as
    // announced, so old seasons don't suddenly produce "season complete" messages.
    let completedSeason = item.completed_season;
    if (completedSeason === null || completedSeason === undefined) {
        // With new content in hand, only seasons before the current one count as
        // announced, so a finale arriving on this very check is still announced.
        if (hasNewContent) completedSeason = currentSeason - 1;
        else completedSeason = complete ? currentSeason : currentSeason - 1;
        await item.update({ completed_season: completedSeason });
    }

    // Completion is announced once per season, on whichever check first sees it —
    // possibly a later one than the final episode, if TMDB still listed more then.
    const announceComplete = complete && completedSeason < currentSeason;
    if (!hasNewContent && !announceComplete) return;

    log.info(
        `[Cron] "${item.title}": S${currentSeason}E${currentEpisode}` +
            (hasNewContent ? ' new' : '') +
            (announceComplete ? ', season complete' : '')
    );
    const epName = lastE.name || 'Без названия';
    const links = formatWatchLinks({ title: item.title, kinopoiskId: item.kinopoisk_id, mediaType: 'tv' });
    const messages = buildSeriesMessages({
        title: item.title,
        season: currentSeason,
        episode: currentEpisode,
        episodeName: epName,
        links
    });

    // A message that doesn't go out is queued by notify(), so the episode is recorded as
    // announced either way
    for (const chat of item.Chats || []) {
        const mode = chat.Subscription.notify_type;
        let kind = null;
        if (mode === 'episode') {
            if (hasNewContent) kind = 'episode';
        } else if (mode === 'season') {
            if (announceComplete) kind = 'complete';
        } else if (mode === 'first_and_full') {
            // A one-episode season is both premiere and finale: one message is enough. Episodes
            // out together reach the check as the last of them, so a new season is its premiere
            // even past episode 1 — unless the whole season is already out. A row stored at a
            // special (season 0, newSeriesFields()) has no regular season to move on from.
            const afterSpecial = !item.last_season && item.last_episode > 0;
            if (hasNewContent && currentEpisode === 1) kind = 'premiere';
            else if (announceComplete) kind = 'complete';
            else if (hasNewSeason && !afterSpecial) kind = 'premiere';
        }
        if (!kind) continue;
        await notify(bot, chat.id, messages[kind], {
            photo: item.poster_url,
            about: item.title,
            event: {
                detail: kind,
                tmdb_id: item.tmdb_id,
                title: item.title,
                season: currentSeason,
                episode: currentEpisode
            },
            ...heldLine({
                kind,
                title: item.title,
                season: currentSeason,
                episode: currentEpisode,
                episodeName: lastE.name
            })
        });
    }

    await item.update({
        last_season: currentSeason,
        last_episode: currentEpisode,
        last_episode_name: epName,
        ...(announceComplete ? { completed_season: currentSeason } : {})
    });
};

const checkSeriesUpdates = async (bot, allSeries) => {
    for (const item of allSeries) {
        tally('series');
        try {
            const [mediaType, filmId] = item.tmdb_id.split('_');
            // The current and next season come in the same request, for the calendar
            const tmdbData = await getDetails(filmId, mediaType, { seasons: seasonsAlong(item) });
            if (!tmdbData) continue;
            // The last aired and next episode by TVmaze's air times where it knows them, so an
            // episode is announced once it has aired, not once TMDB moves it (≈ a day later)
            const times = await tvmaze.airTimesForCheck(item.tmdb_id, tvmaze.externalsOf(tmdbData));
            const data = await withTvmaze(tmdbData, times);

            // Store the status first so a failure in the episode step below can't hold up the
            // archive move. The status message is still sent last: a finale often airs in the
            // same check that flips the status to Ended, and "new episode" should come first.
            const oldStatus = item.status;
            const statusChanged = Boolean(data.status) && data.status !== oldStatus;
            // The next episode, and what the series is (genres, channel, rating) for the statistics
            const fresh = { ...nextEpisodeFields(data), ...titleFacts(data, 'tv') };
            const freshChanged = Object.keys(fresh).some((k) => String(item[k] ?? '') !== String(fresh[k] ?? ''));
            if (statusChanged || freshChanged) {
                await item.update({ ...(statusChanged ? { status: data.status } : {}), ...fresh });
            }

            // Cached on the row after the first hit, so this is a lookup only for new titles
            await ensureKinopoiskId(item, data.imdb_id);
            // Read before notifyNewEpisodes() moves last_season and last_episode on
            const rescan = seasonsToRescan(item, data);

            try {
                await notifyNewEpisodes(bot, item, data);
            } catch (err) {
                tally('errors');
                log.error(`[Cron] Episode check failed for ${item.tmdb_id} ("${item.title}"): ${err.message}`);
            }

            if (statusChanged) await notifyStatusChange(bot, item, oldStatus, data.status);

            // Statistics and release-year counts, after notifications so slow TMDB never holds
            // them up: the season with a new episode is read again; the first time, all of them,
            // in the background for a title whose counts have not been filled yet
            const airedDone = ensureAiredEpisodes(item, data, rescan)
                .then(() => ensureReleaseSeasons(item, data))
                .catch((err) => log.error(`[Stats] Aired episodes for ${item.tmdb_id} failed: ${err.message}`));
            if (item.aired_episodes !== null && item.aired_episodes !== undefined) await airedDone;

            // The calendar's seasons stay in memory: most came with the details above
            await warmSeasons(item, data).catch((err) =>
                log.error(`[Calendar] Seasons for ${item.tmdb_id} failed: ${err.message}`)
            );
        } catch (err) {
            tally('errors');
            log.error(`[Cron] Error checking series ${item.tmdb_id} ("${item.title}"): ${err.message}`);
        }
    }
};

module.exports = { checkSeriesUpdates, notifyNewEpisodes, notifyStatusChange, isSeasonComplete };
