import { locale } from './i18n.js';
import { t as i18nText } from './i18n.js';
import { titleMarkup } from './catalog-text.js';
/**
 * A chat's statistics (/api/chat/:id/stats, src/chat-stats.js): what came out of what it follows,
 * what it is into, the notifications it got and how it uses the bot, for last year, this year or
 * all the time. From there, a preview of the year's recap cards (src/recap/): images only, nothing
 * is sent.
 */

import { $, escapeHtml } from './dom.js';
import { activeLine, shortDay, genreName } from './format.js';
import { api, apiImage } from './api.js';
import { openModal, setReturnTo, showConfirm, toast } from './ui.js';

const MONTHS = [
    i18nText('Jan'),
    i18nText('Feb'),
    i18nText('Mar'),
    i18nText('Apr'),
    i18nText('May'),
    i18nText('Jun'),
    i18nText('Jul'),
    i18nText('Aug'),
    i18nText('Sep'),
    i18nText('Oct'),
    i18nText('Nov'),
    i18nText('Dec')
];
const FEATURES = {
    query: i18nText('Searches'),
    search: i18nText('Search menu'),
    card: i18nText('Title cards'),
    subs: i18nText('Subscriptions'),
    calendar: i18nText('Calendar'),
    history: i18nText('History'),
    settings: i18nText('Settings'),
    help: i18nText('Help'),
    start: i18nText('Start'),
    held: i18nText('Overnight list')
};
const regions = new Intl.DisplayNames([locale], { type: 'region' });
const number = new Intl.NumberFormat(locale);

let chatId = null;
let chatName = '';
// Back to the chat's menu, from the statistics (chats.js gives it)
let period = 'year';
// Only the latest request may fill a dialog: switching the period or the chat outruns the older
const state = { request: 0, recap: 0 };

const thisYear = () => new Date().getFullYear();
const today = () => new Intl.DateTimeFormat('en-CA').format(new Date());
const hours = (minutes) => Math.round(minutes / 60);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const country = (code) => {
    try {
        return regions.of(code) || code;
    } catch {
        return code;
    }
};
const plural = (n, one, many = `${one}s`) =>
    locale === 'ru-RU' ? i18nText(`{{count}} ${one}`, { count: n }) : `${number.format(n)} ${n === 1 ? one : many}`;
const day = (iso) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

/** The periods: last year, this year, everything. */
function periods() {
    const year = thisYear();
    return [
        { key: 'last', label: String(year - 1), query: `year=${year - 1}` },
        { key: 'year', label: String(year), query: `year=${year}` },
        { key: 'all', label: i18nText('All time'), query: `from=2000-01-01&to=${today()}` }
    ];
}

function renderPeriods() {
    $('chat-stats-periods').innerHTML = periods()
        .map(
            (p) =>
                `<button type="button" class="btn${p.key === period ? ' active' : ''}" data-action="chat-stats-period" data-period="${p.key}" aria-pressed="${p.key === period}">${escapeHtml(p.label)}</button>`
        )
        .join('');
}

const kpi = (label, value, note, extra = '') =>
    `<div class="stats-kpi"><span class="stats-kpi-label">${label}</span><span class="stats-kpi-value">${value}</span><span class="stats-kpi-note${extra}">${note}</span></div>`;

const box = (title, aside, body, extra = '') =>
    `<section class="stats-box${extra}"><h4 class="stats-box-title">${title}${aside ? `<span>${aside}</span>` : ''}</h4>${body}</section>`;

/** Rows with a bar each, against the first (largest). */
function meters(items, name = (x) => x) {
    if (!items.length) return '<p class="stats-empty stats-slot-meters">' + i18nText('Nothing yet') + '</p>';
    const top = items[0].n || 1;
    return `<ul class="stats-list stats-slot-meters">${items
        .slice(0, 3)
        .map(
            (i) =>
                `<li class="stats-meter"><span class="stats-name">${escapeHtml(name(i.name))}</span><span class="stats-count">${number.format(i.n)}</span><span class="stats-bar" aria-hidden="true"><i style="width:${Math.round((i.n / top) * 100)}%"></i></span></li>`
        )
        .join('')}</ul>`;
}

/** Plain rows: a name and a figure. */
function rows(items, empty = i18nText('Nothing yet')) {
    if (!items.length) return `<p class="stats-empty stats-slot-rows">${empty}</p>`;
    return `<ul class="stats-list stats-slot-rows">${items
        .map(
            ([name, value, crown, id]) =>
                `<li class="stats-row"><span class="stats-name">${crown ? '<span class="stats-crown" role="img" aria-label="' + i18nText('Added clearly the most') + '" title="' + i18nText('Added clearly the most') + '">★</span>' : ''}${id ? titleMarkup(id, name) : escapeHtml(name)}</span><span class="stats-count">${escapeHtml(value)}</span></li>`
        )
        .join('')}</ul>`;
}

/** One of the bot's comings and goings in the chat (src/bot-status.js), as a line. */
function botEventLine({ kind, detail, by }, chatType) {
    const lines = {
        started: i18nText('Started the bot'),
        added: by ? i18nText('Added by {{v0}}', { v0: by }) : i18nText('Added to the group'),
        returned: i18nText('Came back'),
        stopped: i18nText('Stopped the bot'),
        removed: by ? i18nText('Removed by {{v0}}', { v0: by }) : i18nText('Removed from the group'),
        deleted: chatType === 'private' ? i18nText('Account deleted') : i18nText('Chat deleted')
    };
    return lines[detail] || (kind === 'bot_on' ? i18nText('Came back') : i18nText('Left the bot'));
}

/** "Bot in this chat": the latest times it was added, removed, blocked or started; nothing if none. */
function botHistory(bot, chatType) {
    const history = (bot && bot.history) || [];
    if (!history.length) return '';
    return (
        '<h4 class="stats-box-title stats-subtitle">' +
        i18nText('Bot in this chat') +
        '</h4>' +
        rows(history.map((e) => [botEventLine(e, chatType), shortDay(e.at)]))
    );
}

/** Bars: the year's months, or for all time one bar a year. */
function chart(stats) {
    const single = stats.period.from.slice(0, 4) === stats.period.to.slice(0, 4);
    const bars = [];
    if (single) {
        const year = stats.period.from.slice(0, 4);
        const byMonth = new Map(stats.episodes.byMonth.map((m) => [m.month, m.count]));
        MONTHS.forEach((label, i) =>
            bars.push({ label, count: byMonth.get(`${year}-${String(i + 1).padStart(2, '0')}`) || 0 })
        );
    } else {
        const byYear = new Map();
        for (const m of stats.episodes.byMonth) {
            const year = m.month.slice(0, 4);
            byYear.set(year, (byYear.get(year) || 0) + m.count);
        }
        for (const [label, count] of [...byYear].sort()) bars.push({ label, count });
    }
    if (!bars.some((b) => b.count))
        return '<p class="stats-empty stats-chart-empty">' + i18nText('No episodes in this period') + '</p>';
    const max = Math.max(...bars.map((b) => b.count));
    const busiest = bars.find((b) => b.count === max);
    return (
        '<div class="stats-chart" role="img" aria-label="' +
        i18nText('Episodes: {{v0}}', { v0: escapeHtml(bars.map((b) => `${b.label} ${b.count}`).join(', ')) }) +
        '">' +
        bars
            .map(
                (b) =>
                    `<div class="stats-col"><span class="stats-col-bar${b === busiest ? ' busiest' : ''}" style="height:${Math.round((b.count / max) * 100)}%" title="${escapeHtml(b.label)}: ${b.count}"></span><span class="stats-col-label">${escapeHtml(b.label)}</span></div>`
            )
            .join('') +
        '</div>'
    );
}

/** The whole body for one answer. */
export function renderStats(stats, chatType = 'private') {
    const ep = stats.episodes;
    const out = stats.notifications.outcomes || {};
    const lost = out.failed || 0;
    const films = stats.films.released;
    const following = stats.following.series + stats.following.films;
    const busiest = ep.busiestMonth
        ? i18nText('busiest: {{v0}}{{v1}}, {{v2}}', {
              v0: MONTHS[Number(ep.busiestMonth.month.slice(5)) - 1],
              v1:
                  stats.period.from.slice(0, 4) === stats.period.to.slice(0, 4)
                      ? ''
                      : ` ${ep.busiestMonth.month.slice(0, 4)}`,
              v2: ep.busiestMonth.count
          })
        : '';
    const features = stats.usage.features.map((f) => [FEATURES[f.name] || capital(f.name), number.format(f.n)]);
    const members = stats.members || { added: [], used: [] };
    // The server says whether the first added clearly the most (the same rule as the caption's line)
    const added = members.added.map((m, i) => [
        m.name,
        [m.series && plural(m.series, 'series', 'series'), m.films && plural(m.films, 'film')]
            .filter(Boolean)
            .join(' · '),
        i === 0 && Boolean(members.leader)
    ]);
    const used = members.used.map((m) => [m.name, plural(m.n, 'time')]);
    const group = chatType !== 'private';
    const since = stats.since
        ? i18nText('Notifications, bot use and who added what are counted since {{v0}}, when recording began.', {
              v0: day(stats.since)
          })
        : i18nText('Notifications, bot use and who added what: nothing recorded for this chat yet.');

    return `
        <div class="stats-kpis">
            ${kpi(i18nText('Episodes out'), number.format(ep.count), `${plural(ep.seasons, 'season')} · ${plural(ep.series, 'series', 'series')}`)}
            ${kpi(i18nText('Hours of premieres'), number.format(hours(ep.minutes)), i18nText('+ {{v0}}, {{v1}} h', { v0: plural(films.length, 'film'), v1: hours(stats.films.minutes) }))}
            ${kpi(i18nText('Notifications'), number.format(stats.notifications.total), i18nText('{{v0}} after quiet hours · {{v1}} lost', { v0: number.format(out.held || 0), v1: number.format(lost) }))}
            ${kpi(i18nText('Following'), number.format(following), i18nText('{{v0}} · {{v1}} ahead', { v0: plural(stats.following.series, 'series', 'series'), v1: plural(stats.following.films, 'film') }))}
        </div>
        ${box(i18nText('Episodes by month'), busiest, chart(stats), ' stats-chart-box')}
        <div class="stats-cols stats-cols-3">
            ${box(i18nText('Genres'), '', meters(stats.favourites.genres, genreName))}
            ${box(i18nText('Channels'), '', meters(stats.favourites.networks))}
            ${box(i18nText('Countries'), '', meters(stats.favourites.countries, country))}
        </div>
        <div class="stats-cols stats-cols-2">
            ${box(
                i18nText('Most episodes'),
                '',
                rows(
                    ep.top
                        .slice(0, 3)
                        .map((s) => [
                            s.title,
                            i18nText('{{v0}} · {{v1}} h', { v0: s.count, v1: hours(s.minutes) }),
                            false,
                            s.tmdb_id
                        ])
                ) +
                    ('<h4 class="stats-box-title stats-subtitle">' +
                        i18nText('Films out') +
                        '<span>' +
                        number.format(films.length) +
                        '</span></h4>') +
                    rows(
                        [...films]
                            .sort((a, b) => b.waited - a.waited)
                            .slice(0, 3)
                            .map((f) => [
                                f.title,
                                f.waited ? i18nText('waited {{v0}}', { v0: plural(f.waited, 'day') }) : day(f.day),
                                false,
                                f.tmdb_id
                            ]),
                        i18nText('No films out')
                    )
            )}
            ${box(
                i18nText('Bot use'),
                number.format(stats.usage.total),
                rows(features.slice(0, 3), i18nText('Not used yet')) +
                    (group
                        ? '<h4 class="stats-box-title stats-subtitle">' +
                          i18nText('Added most') +
                          '</h4>' +
                          rows(added.slice(0, 3), i18nText('Nobody yet')) +
                          ('<h4 class="stats-box-title stats-subtitle">' +
                              i18nText('Used the bot most') +
                              '</h4>' +
                              rows(used.slice(0, 3), i18nText('Nobody yet')))
                        : '') +
                    botHistory(stats.bot, chatType)
            )}
        </div>
        <p class="stats-note">${escapeHtml(since)}</p>`;
}

/** The same shapes, empty: nothing moves when the answer comes. */
function renderSkeleton(chatType) {
    const line = '<span class="skeleton"></span>';
    const row = (kind) => `<li class="stats-${kind} skeleton-row"><span class="stats-name">${line}</span></li>`;
    const list = `<ul class="stats-list stats-slot-rows">${row('row').repeat(3)}</ul>`;
    const meters = `<ul class="stats-list stats-slot-meters">${row('meter').repeat(3)}</ul>`;
    return `
        <div class="stats-kpis">${`<div class="stats-kpi"><span class="stats-kpi-label">${line}</span><span class="stats-kpi-value"><span class="skeleton skeleton-figure"></span></span><span class="stats-kpi-note">${line}</span></div>`.repeat(4)}</div>
        ${box(i18nText('Episodes by month'), '', '<div class="stats-chart"></div>', ' stats-chart-box')}
        <div class="stats-cols stats-cols-3">${[i18nText('Genres'), i18nText('Channels'), i18nText('Countries')].map((t) => box(t, '', meters)).join('')}</div>
        <div class="stats-cols stats-cols-2">
            ${box(i18nText('Most episodes'), '', list + ('<h4 class="stats-box-title stats-subtitle">' + i18nText('Films out') + '</h4>') + list)}
            ${box(i18nText('Bot use'), '', list + (chatType !== 'private' ? '<h4 class="stats-box-title stats-subtitle">' + i18nText('Added most') + '</h4>' + list + '<h4 class="stats-box-title stats-subtitle">' + i18nText('Used the bot most') + '</h4>' + list : ''))}
        </div>
        <p class="stats-note">${line}</p>`;
}

let chatType = 'private';

async function load() {
    const request = ++state.request;
    const body = $('chat-stats-body');
    body.setAttribute('aria-busy', 'true');
    body.innerHTML = renderSkeleton(chatType);
    const query = periods().find((p) => p.key === period).query;
    try {
        const stats = await api(`/chat/${chatId}/stats?${query}`);
        if (request !== state.request) return;
        body.innerHTML = renderStats(stats, chatType);
    } catch (err) {
        if (request !== state.request) return;
        body.innerHTML =
            '<p class="stats-failed">' +
            i18nText('Failed to load: {{v0}}. Pick the period again to retry.', { v0: escapeHtml(err.message) }) +
            '</p>';
    } finally {
        if (request === state.request) body.removeAttribute('aria-busy');
    }
}

/** Opens the dialog for a chat, on this year. */
export function openChatStats(chat, label) {
    chatId = chat.id;
    chatName = label;
    chatType = chat.type || 'private';
    period = 'year';
    $('chat-stats-sub').textContent = [label, chatType, activeLine(chat.last_seen_at)].filter(Boolean).join(' · ');
    renderPeriods();
    openModal('chat-stats-modal');
    load();
}

/** A period button (data-action="chat-stats-period"). */
export function pickPeriod(key) {
    if (!chatId) return;
    period = key;
    renderPeriods();
    load();
}

// --- The year's recap: six PNGs drawn by the server ---

// The object URLs on show, freed when the next preview opens
let shown = [];
// The preview on screen: its chat and year, and where closing it returns
const preview = { id: null, year: null, back: null, sentAt: null };

/**
 * The preview of a chat's year: its six cards and whether it was sent, with the button. Also from
 * Year recap → Ready cards.
 * @param {string | number} id
 * @param {string} name
 * @param {number} year
 * @param {(() => void) | null} back what closing it goes back to
 */
export function showRecap(id, name, year, back = null) {
    const request = ++state.recap;
    chatName = name;
    Object.assign(preview, { id, year, back, sentAt: null });
    setReturnTo(back);
    for (const url of shown) URL.revokeObjectURL(url);
    shown = [];
    $('recap-title').textContent = i18nText('{{v0}} recap', { v0: year });
    $('recap-sub').textContent = chatName;
    const cards = $('recap-cards');
    cards.innerHTML = [1, 2, 3, 4, 5, 6]
        .map((n) => `<div class="recap-card" data-card="${n}"><span class="skeleton"></span></div>`)
        .join('');
    openModal('recap-modal');
    loadRecapStatus(request);
    // One after another: the first request draws all six on the server, the rest come from its cache
    (async () => {
        for (const n of [1, 2, 3, 4, 5, 6]) {
            const slot = cards.querySelector(`[data-card="${n}"]`);
            try {
                const blob = await apiImage(`/chat/${id}/recap/${n}?year=${year}`);
                if (request !== state.recap) return;
                const url = URL.createObjectURL(blob);
                shown.push(url);
                slot.innerHTML =
                    '<img src="' +
                    url +
                    '" alt="' +
                    i18nText('Card {{v1}} of 6', { v1: n }) +
                    '" width="1080" height="1350" />';
            } catch (err) {
                if (request !== state.recap) return;
                slot.innerHTML =
                    '<p class="stats-failed">' +
                    i18nText('Failed to load: {{v0}}', { v0: escapeHtml(err.message) }) +
                    '</p>';
            }
        }
    })();
}

// --- Sending this chat its year (src/recap/send.js): queued, then sent in the background ---

const when = (iso) =>
    new Date(iso).toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

/** The preview's footer: whether this chat has its year, and the button. */
async function loadRecapStatus(request) {
    const status = $('recap-status');
    status.textContent = i18nText('Checking whether it was sent…');
    $('recap-actions').innerHTML = '';
    try {
        const answer = await api(`/chat/${preview.id}/recap-status?year=${preview.year}`);
        if (request !== state.recap) return;
        renderRecapStatus(answer);
    } catch (err) {
        if (request !== state.recap) return;
        status.textContent = i18nText("Couldn't check whether it was sent: {{v0}}", { v0: err.message });
    }
}

/** @param {{ status: string | null, sentAt: string | null, error: string | null }} answer */
function renderRecapStatus(answer) {
    const status = $('recap-status');
    const actions = $('recap-actions');
    const button = (label, extra = '') => `<button type="button" class="btn btn-primary"${extra}>${label}</button>`;
    if (answer.status === 'sent') {
        preview.sentAt = answer.sentAt;
        status.innerHTML =
            '<span class="recap-dot" aria-hidden="true"></span>' +
            i18nText('Sent {{v0}}', { v0: escapeHtml(when(answer.sentAt)) });
        // Once more on purpose only: its own question says it already got it
        actions.innerHTML =
            '<button type="button" class="btn btn-ghost" data-action="recap-send-one" data-again="true">' +
            i18nText('Send again') +
            '</button>';
        return;
    }
    if (answer.status === 'queued' || answer.status === 'sending') {
        status.textContent = i18nText("Queued: goes out shortly, or when the chat's quiet hours end.");
        actions.innerHTML = button(i18nText('Queued'), ' disabled');
        return;
    }
    const failed =
        answer.status === 'failed'
            ? i18nText('Failed: {{v0}}.', { v0: answer.error || i18nText('unknown error') }) + ' '
            : '';
    const label = answer.status === 'failed' ? i18nText('Send again') : i18nText('Send to this chat');
    status.textContent = failed || i18nText('Not sent to this chat yet.');
    actions.innerHTML = button(label, ' data-action="recap-send-one"');
}

/**
 * The footer's button (data-action="recap-send-one"): asks first, then queues it. `again`: the
 * chat already got its year, and the question says so.
 */
export function confirmSendOne(again = false) {
    const { id, year, back, sentAt } = preview;
    if (!id) return;
    // "No" or Escape on the question leaves the preview open, and closing it still goes back
    setReturnTo(() => setReturnTo(back));
    const quiet = i18nText("In the chat's quiet hours it goes out when they end.");
    showConfirm({
        title: again
            ? i18nText('Send the {{v0}} recap again?', { v0: year })
            : i18nText('Send the {{v0}} recap?', { v0: year }),
        text: again
            ? i18nText('{{v0}} already got it on {{v1}}. It will get the six pictures once more. {{v2}}', {
                  v0: chatName,
                  v1: sentAt ? when(sentAt) : i18nText('an earlier day'),
                  v2: quiet
              })
            : i18nText("Six pictures in one message to {{v0}}. This can't be undone. {{v1}}", {
                  v0: chatName,
                  v1: quiet
              }),
        confirmLabel: again ? i18nText('Send again') : i18nText('Send'),
        cancelLabel: i18nText('No, cancel'),
        onConfirm: async () => {
            setReturnTo(back);
            try {
                await api(`/chat/${id}/recap/send`, { method: 'POST', body: again ? { year, again: true } : { year } });
                toast(i18nText('Queued: the recap goes out shortly'), 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            if (preview.id === id && preview.year === year) loadRecapStatus(state.recap);
        }
    });
}
