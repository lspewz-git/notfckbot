/** The notification texts the update check sends. Pure: no Telegram, database or network. */
const {
    isFinishedStatus,
    escapeHtml,
    formatRuDate,
    extraFilmDates,
    countryName,
    countryList
} = require('../constants');
const { onlineDate, releaseDate, worldwideRelease } = require('../film-release');

/**
 * The three series notifications, as sent to subscribers. Exported so the admin
 * panel's test message is the real one, not a copy that can drift.
 */
function buildSeriesMessages({ title, season, episode, episodeName, links }) {
    const t = escapeHtml(title);
    const ep = escapeHtml(episodeName || 'Без названия');
    const head = `⚡️ Новая серия! <b>${t}</b> — Сезон ${season}, Серия ${episode}: ${ep}`;
    return {
        episode: `${head}\n\n${links}`,
        // "Every episode" mode at the season's last episode
        finale: `${head}\n🏁 <b>Последняя известная серия сезона</b> — по текущему расписанию, сезон ${season}.\n\n${links}`,
        // Several episodes out at once reach the check as the last of them: name the range then
        premiere: `🆕 <b>Премьера сезона!</b>\n\n📺 <b>${t}</b>\n🎞 Сезон ${season}, ${Number(episode) > 1 ? `последняя вышедшая серия ${episode}: ${ep}` : `Серия 1: ${ep}`}\n\n${links}\n\n<i>(Вы также получите уведомление, когда по расписанию выйдет весь сезон)</i>`,
        complete: `✅ <b>Вышли известные серии сезона</b>\n\n📺 <b>${t}</b>\n📦 Сезон ${season}: по текущему расписанию вышли все известные серии (${episode} сер.).\n\n${links}`
    };
}

/** A show crossed the running/finished line: cancelled, finished, or renewed. */
function buildStatusMessage(title, newStatus, { source = null, url = null } = {}) {
    const t = escapeHtml(title);
    const sourceName = source ? escapeHtml(source) : null;
    const attribution = sourceName
        ? `По данным ${url && /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}">${sourceName}</a>` : sourceName}`
        : 'В каталоге';
    // The title on a line of its own, as in the episode alerts: inside a sentence it got lost
    return isFinishedStatus(newStatus)
        ? 'ℹ️ <b>Обновился статус сериала</b>\n\n' +
              `📺 <b>${t}</b>\n\n` +
              `${attribution} сериал отмечен как ${newStatus === 'Canceled' ? 'отменённый' : 'завершённый'}. ` +
              'Перенёс его в 📺 Мои подписки → 🗄 Завершённые. Продолжу проверять обновления.'
        : `ℹ️ <b>Обновился статус сериала</b>\n\n📺 <b>${t}</b>\n\n` +
              `${attribution} статус изменился. Сериал снова в активных подписках. Продолжу сообщать о новых сериях.`;
}

/** Old queued status observations keep their title, never their categorical claims. */
function neutralizeStoredStatus(text) {
    if (typeof text !== 'string') return text;
    const status = text.match(
        /^(🧪 <b>\[Тестовое уведомление\]<\/b>\n\n)?(?:🏁|⛔|🎉) (?:<b>)?Сериал (?:заверш[её]н|отмен[её]н|продлили!?)(?:<\/b>)?\n\n(📺 (?:<b>)?[^\n]+)\n\n/u
    );
    if (status)
        return (
            `${status[1] || ''}ℹ️ <b>Обновился статус сериала</b>\n\n${status[2]}\n\n` +
            'На момент подготовки уведомления в каталоге изменился статус сериала. Проверка обновлений продолжается.'
        );
    return text.replace(
        /^(📺 <b>[^\n]+<\/b> — )сериал (?:заверш[её]н|отмен[её]н|продлили)$/u,
        '$1в каталоге изменился статус на момент подготовки уведомления'
    );
}

/** A film message's title and director lines. */
const filmHead = (entry, data) =>
    `🍿 <b>${escapeHtml(entry.title)}</b>${entry.year ? ` (${entry.year})` : ''}\n` +
    (data.director_name ? `🎬 Режиссер: <b>${escapeHtml(data.director_name)}</b>\n` : '');

const NO_DIGITAL_DATE = '💻 Дата цифрового релиза неизвестна\n';

/**
 * The cinema release message, with a known digital date as additional information only.
 * @param {{ entry: object, data: object, links: string, now?: Date, ru?: object }} parts
 *   ru: Kinopoisk's Russian dates (russianDates)
 */
function buildFilmMessage({ entry, data, links, now = new Date(), today, ru = {} }) {
    const online = onlineDate(data, ru);
    const release = releaseDate(data, ru);
    // The release may be a day into the wave that worldwideRelease starts at a lone early market
    const wave = worldwideRelease(data);
    const inWave =
        wave &&
        release &&
        release.date >= wave.date &&
        Date.parse(release.date) <= Date.parse(wave.date) + 6 * 24 * 60 * 60 * 1000;
    const where = inWave ? 'мировой прокат' : countryList(release?.countries);
    const dates = extraFilmDates(
        {
            ...data,
            digital_release_date: online?.country === 'RU' && online.date === ru.digital ? null : online?.date,
            digital_release_country: online?.country
        },
        ru,
        { markExpected: now, today, cinema: false }
    ).join('');
    return (
        `🎬 <b>Фильм вышел!</b>\n\n` +
        filmHead(entry, data) +
        (release ? `📅 Дата релиза: <b>${formatRuDate(release.date)}</b>${where ? ` (${where})` : ''}\n` : '') +
        (dates || NO_DIGITAL_DATE) +
        '\n' +
        links
    );
}

/**
 * The independent digital release message, only for chats that opted in.
 */
function buildDigitalMessage({ entry, data, ru = {}, links }) {
    const online = onlineDate(data, ru);
    const country = online?.country ? ` (${escapeHtml(countryName(online.country))})` : '';
    return (
        `💻 <b>Фильм вышел онлайн!</b>\n\n` +
        filmHead(entry, data) +
        `📅 Цифровой релиз: <b>${formatRuDate(online?.date) || 'дата неизвестна'}</b>${country}\n\n` +
        links
    );
}

// --- Test notifications ---
// Every alert the bot sends, by the name the admin panel uses for it. A test message is built by
// the same function as the real one, so it shows exactly what subscribers would get.
const EPISODE_MODES = ['episode', 'first_and_full', 'season'];
// The status each status alert is about: finished, cancelled, back on air
const STATUS_MODES = { ended: 'Ended', canceled: 'Canceled', renewed: 'Returning Series' };
const TEST_MODES = [...EPISODE_MODES, ...Object.keys(STATUS_MODES), 'film'];
const TEST_PREFIX = '🧪 <b>[Тестовое уведомление]</b>\n\n';

/**
 * The real message for `mode`, marked as a test.
 * @param {string} mode one of TEST_MODES
 * @param {{ title?: string, season?: number, episode?: number, episodeName?: string, links?: string,
 *   source?: { source?: string | null, url?: string | null },
 *   film?: { entry: object, data: object, ru?: object, now?: Date, today?: string } }} parts
 *   what that mode's message is made of
 */
function buildTestMessage(mode, { title, season, episode, episodeName, links, film, source }) {
    if (mode === 'film') return TEST_PREFIX + buildFilmMessage({ ...film, links });
    if (STATUS_MODES[mode]) return TEST_PREFIX + buildStatusMessage(title, STATUS_MODES[mode], source);
    const messages = buildSeriesMessages({ title, season, episode, episodeName, links });
    const real =
        mode === 'season' ? messages.complete : mode === 'first_and_full' ? messages.premiere : messages.episode;
    return TEST_PREFIX + real;
}

/**
 * A held notification's line in the list that comes after quiet hours, and its button.
 * @param {{ kind: 'episode' | 'premiere' | 'complete' | 'status' | 'film' | 'digital', title: string,
 *   season?: number, episode?: number, episodeName?: string, status?: string, finale?: boolean }} what
 *   finale: the episode ends its season ("every episode" mode)
 * @returns {{ line: string, label: string }}
 */
function heldLine({ kind, title, season, episode, episodeName, status, finale = false }) {
    const t = escapeHtml(title);
    const code = `S${season}E${episode}`;
    switch (kind) {
        case 'episode':
            return {
                line:
                    `📺 <b>${t}</b> — серия ${code}${episodeName ? ` «${escapeHtml(episodeName)}»` : ''}` +
                    (finale ? ', последняя известная серия сезона по текущему расписанию' : ''),
                label: `${title} ${code}`
            };
        case 'premiere':
            return { line: `📺 <b>${t}</b> — премьера ${season} сезона`, label: `${title} ${code}` };
        case 'complete':
            return {
                line: `📺 <b>${t}</b> — по текущему расписанию вышел весь ${season} сезон`,
                label: `${title}: ${season} сезон`
            };
        case 'status': {
            const what = !isFinishedStatus(status)
                ? 'снова в активных подписках'
                : status === 'Canceled'
                  ? 'в каталоге отмечен как отменённый'
                  : 'в каталоге отмечен как завершённый';
            return { line: `📺 <b>${t}</b> — ${what}`, label: title };
        }
        case 'digital':
            return { line: `💻 <b>${t}</b> — вышел онлайн`, label: title };
        default:
            return { line: `🎬 <b>${t}</b> — фильм вышел`, label: title };
    }
}

module.exports = {
    neutralizeStoredStatus,
    heldLine,
    buildSeriesMessages,
    buildStatusMessage,
    buildFilmMessage,
    buildDigitalMessage,
    buildTestMessage,
    TEST_MODES,
    EPISODE_MODES,
    STATUS_MODES
};
