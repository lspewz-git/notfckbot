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
const { withTvmaze, outAt } = require('../episode-times');
const { derivedSeries } = require('./series-derived');

// Tell subscribers when a show crosses the running/finished line. Ended <-> Canceled and
// Returning <-> In Production changes are not interesting to users and stay silent.
// Ended/canceled shows are shown in the bot's "Завершённые" archive instead of the active list.
const notifyStatusChange = async (bot, item, oldStatus, newStatus) => {
    // The first status fill (null -> X) is bookkeeping, not news.
    if (!oldStatus || isFinishedStatus(oldStatus) === isFinishedStatus(newStatus)) return;

    const source = item.episode_source === 'tvmaze' ? 'TVmaze' : 'TMDB';
    const url =
        item.episode_source === 'tvmaze' && item.tvmaze_id
            ? `https://www.tvmaze.com/shows/${item.tvmaze_id}`
            : `https://www.themoviedb.org/tv/${item.tmdb_id.replace('tv_', '')}`;
    const msg = buildStatusMessage(item.title, newStatus, { source, url });

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
    // Specials (season 0) are no season to finish; without TVmaze's answer a season TMDB lists only
    // up to its last aired episode would read as complete: wait for a check that has it
    if (season < 1 || data.tvmaze_missing) return false;
    if (data.tvmaze_primary) return Boolean(data.tvmaze_season_complete);
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
        // Without TVmaze's answer too: taking a season as announced too early only silences it
        else if (complete || isSeasonComplete({ ...data, tvmaze_missing: false }, currentSeason, currentEpisode))
            completedSeason = currentSeason;
        else completedSeason = currentSeason - 1;
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
            // The finale's message says the season is out; completion seen on a later check gets its own
            if (hasNewContent) kind = 'episode';
            else if (announceComplete) kind = 'complete';
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
        const text = kind === 'episode' && announceComplete ? messages.finale : messages[kind];
        await notify(bot, chat.id, text, {
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
                episodeName: lastE.name,
                finale: announceComplete
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
    // TVmaze's share of this check is capped: past it, the times already cached
    const budget = tvmaze.checkBudget();
    for (const item of allSeries) {
        tally('series');
        try {
            const [mediaType, filmId] = item.tmdb_id.split('_');
            // The current and next season come in the same request, for the calendar
            const tmdbData = await getDetails(filmId, mediaType, {
                seasons: seasonsAlong(item),
                tvmazeBudget: budget,
                fallbackSeries: item
            });
            if (!tmdbData) continue;
            if (tmdbData.tvmaze_primary && (tmdbData.tvmaze_missing || tmdbData.seed_only)) continue;
            // The last aired and next episode by TVmaze's air times where it knows them, so an
            // episode is announced once it has aired, not once TMDB moves it (≈ a day later)
            const times = tmdbData.tvmaze_primary
                ? tmdbData.tvmaze_times
                : await tvmaze.airTimesForCheck(item.tmdb_id, tvmaze.externalsOf(tmdbData), budget);
            // undefined: TVmaze didn't answer and nothing is cached (null: the series isn't on TVmaze)
            const data = {
                ...(await withTvmaze(tmdbData, times)),
                tvmaze_missing: tmdbData.tvmaze_missing || times === undefined
            };
            const sourceChanged = Boolean(
                data.data_source &&
                ((data.data_source !== item.episode_source && (data.tvmaze_primary || item.episode_source)) ||
                    (data.tvmaze_primary &&
                        data.tvmaze_id &&
                        item.tvmaze_id &&
                        Number(data.tvmaze_id) !== Number(item.tvmaze_id)))
            );
            const last = data.last_episode_to_air;
            const oldEpisode = Object.hasOwn(data, 'source_cursor_episode')
                ? data.source_cursor_episode
                : data.tmdb_cursor_episode || data.tmdb_last_episode;
            const identity =
                oldEpisode?.season_number === item.last_season &&
                oldEpisode?.episode_number === item.last_episode &&
                oldEpisode.air_date
                    ? oldEpisode
                    : null;
            const candidates = identity
                ? Object.entries(data.tvmaze_times || {}).filter(([, t]) => t.date === identity.air_date)
                : [];
            const exact = candidates.find(([key]) => key === `${item.last_season}:${item.last_episode}`);
            const matched = exact || (candidates.length === 1 ? candidates[0] : null);
            const mapped = matched ? matched[0].split(':').map(Number) : null;
            const sameNumberTime = data.tvmaze_times?.[`${item.last_season}:${item.last_episode}`];
            const uncertainTimes = candidates.length
                ? candidates.map(([, t]) => t)
                : sameNumberTime
                  ? [sameNumberTime]
                  : Object.values(data.tvmaze_times || {});
            // Without an unambiguous identity, wait while any candidate could still arrive.
            // Resetting to TVmaze's earlier cursor here would announce old content again.
            if (
                data.tvmaze_primary &&
                item.last_episode > 0 &&
                ((!last && !(sourceChanged && mapped)) ||
                    (sourceChanged && !mapped && uncertainTimes.some((t) => outAt(t) > Date.now())))
            ) {
                log.warn(`[Cron] Series ${item.tmdb_id} schedule cannot preserve the saved episode identity yet`);
                continue;
            }
            const preserveCursor =
                sourceChanged &&
                mapped &&
                (!last ||
                    mapped[0] > last.season_number ||
                    (mapped[0] === last.season_number && mapped[1] > last.episode_number));
            const mappedSeason = mapped && data.seasons?.find((s) => s.season_number === mapped[0]);
            const baseline = preserveCursor
                ? {
                      last_season: mapped[0],
                      last_episode: mapped[1],
                      last_episode_name: item.last_episode_name || '',
                      completed_season:
                          item.completed_season >= item.last_season &&
                          mappedSeason?.finale_known &&
                          mapped[1] >= mappedSeason.episode_count
                              ? mapped[0]
                              : Math.max(0, mapped[0] - 1)
                  }
                : {
                      last_season: last?.season_number || 0,
                      last_episode: last?.episode_number || 0,
                      last_episode_name: last?.name || '',
                      completed_season: last ? last.season_number - (data.tvmaze_season_complete ? 0 : 1) : 0
                  };

            // Store the status first so a failure in the episode step below can't hold up the
            // archive move. The status message is still sent last: a finale often airs in the
            // same check that flips the status to Ended, and "new episode" should come first.
            const oldStatus = item.status;
            const statusChanged = Boolean(data.status) && data.status !== oldStatus;
            // The next episode, and what the series is (genres, channel, rating) for the statistics
            const fresh = {
                ...nextEpisodeFields(data),
                ...titleFacts(data, 'tv'),
                ...(data.tvmaze_id ? { tvmaze_id: data.tvmaze_id } : {}),
                ...(data.data_source ? { episode_source: data.data_source } : {}),
                ...(data.poster_url ? { poster_url: data.poster_url } : {}),
                ...(sourceChanged ? { ...baseline, aired_episodes: null, release_seasons: null } : {})
            };
            const freshChanged = Object.keys(fresh).some((k) => String(item[k] ?? '') !== String(fresh[k] ?? ''));
            if (statusChanged || freshChanged) {
                await item.update({ ...(statusChanged ? { status: data.status } : {}), ...fresh });
            }

            // Cached on the row after the first hit, so this is a lookup only for new titles
            await ensureKinopoiskId(item, data.imdb_id);
            // Read before notifyNewEpisodes() moves last_season and last_episode on
            const rescan = seasonsToRescan(item, data);

            // Different catalogs may split/number seasons differently. Migrating an existing
            // cursor is bookkeeping, not a premiere, finale or renewal announcement.
            if (sourceChanged) {
                log.info(`[Cron] Series ${item.tmdb_id} switched to ${data.data_source}; existing episodes baselined`);
            }

            try {
                if (!data.tvmaze_missing || item.episode_source !== 'tvmaze') await notifyNewEpisodes(bot, item, data);
            } catch (err) {
                tally('errors');
                log.error(`[Cron] Episode check failed for ${item.tmdb_id} ("${item.title}"): ${err.message}`);
            }

            if (statusChanged && !sourceChanged) await notifyStatusChange(bot, item, oldStatus, data.status);

            // Statistics and release-year counts, after notifications so slow TMDB never holds
            // them up: the season with a new episode is read again; the first time, all of them,
            // in the background for a title whose counts have not been filled yet
            const derived = derivedSeries(item);
            const airedDone = ensureAiredEpisodes(derived, data, rescan)
                .then(() => ensureReleaseSeasons(derived, data))
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
