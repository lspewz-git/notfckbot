/**
 * A chat's statistics (/api/chat/:id/stats, src/chat-stats.js): what came out of what it follows,
 * what it is into, the notifications it got and how it uses the bot, for last year, this year or
 * all the time. From there, a preview of the year's recap cards (src/recap/): images only, nothing
 * is sent.
 */

import { $, escapeHtml } from './dom.js';
import { api, apiImage } from './api.js';
import { openModal, closeModal, setReturnTo, showConfirm, toast } from './ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FEATURES = {
    query: 'Searches',
    search: 'Search menu',
    card: 'Title cards',
    subs: 'Subscriptions',
    calendar: 'Calendar',
    history: 'History',
    settings: 'Settings',
    help: 'Help',
    start: 'Start',
    held: 'Overnight list'
};
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const number = new Intl.NumberFormat('en-GB');

let chatId = null;
let chatName = '';
// Back to the chat's menu, from the statistics (chats.js gives it)
let backToMenu = null;
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
const plural = (n, one, many = `${one}s`) => `${number.format(n)} ${n === 1 ? one : many}`;
const day = (iso) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The periods: last year, this year, everything. */
function periods() {
    const year = thisYear();
    return [
        { key: 'last', label: String(year - 1), query: `year=${year - 1}` },
        { key: 'year', label: String(year), query: `year=${year}` },
        { key: 'all', label: 'All time', query: `from=2000-01-01&to=${today()}` }
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
    if (!items.length) return '<p class="stats-empty stats-slot-meters">Nothing yet</p>';
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
function rows(items, empty = 'Nothing yet') {
    if (!items.length) return `<p class="stats-empty stats-slot-rows">${empty}</p>`;
    return `<ul class="stats-list stats-slot-rows">${items
        .map(
            ([name, value]) =>
                `<li class="stats-row"><span class="stats-name">${escapeHtml(name)}</span><span class="stats-count">${escapeHtml(value)}</span></li>`
        )
        .join('')}</ul>`;
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
    if (!bars.some((b) => b.count)) return '<p class="stats-empty stats-chart-empty">No episodes in this period</p>';
    const max = Math.max(...bars.map((b) => b.count));
    const busiest = bars.find((b) => b.count === max);
    return `<div class="stats-chart" role="img" aria-label="Episodes: ${escapeHtml(bars.map((b) => `${b.label} ${b.count}`).join(', '))}">${bars
        .map(
            (b) =>
                `<div class="stats-col"><span class="stats-col-bar${b === busiest ? ' busiest' : ''}" style="height:${Math.round((b.count / max) * 100)}%" title="${escapeHtml(b.label)}: ${b.count}"></span><span class="stats-col-label">${escapeHtml(b.label)}</span></div>`
        )
        .join('')}</div>`;
}

/** The whole body for one answer. */
export function renderStats(stats, chatType = 'private') {
    const ep = stats.episodes;
    const out = stats.notifications.outcomes || {};
    const lost = out.failed || 0;
    const films = stats.films.released;
    const following = stats.following.series + stats.following.films;
    const busiest = ep.busiestMonth
        ? `busiest: ${MONTHS[Number(ep.busiestMonth.month.slice(5)) - 1]}${stats.period.from.slice(0, 4) === stats.period.to.slice(0, 4) ? '' : ` ${ep.busiestMonth.month.slice(0, 4)}`}, ${ep.busiestMonth.count}`
        : '';
    const features = stats.usage.features.map((f) => [FEATURES[f.name] || capital(f.name), number.format(f.n)]);
    const members = stats.usage.members.map((m) => [m.name, plural(m.n, 'action')]);
    const group = chatType !== 'private';
    const since = stats.since
        ? `Notifications and bot use are counted since ${day(stats.since)}, when recording began.`
        : 'Notifications and bot use: nothing recorded for this chat yet.';

    return `
        <div class="stats-kpis">
            ${kpi('Episodes out', number.format(ep.count), `${plural(ep.seasons, 'season')} · ${plural(ep.series, 'series', 'series')}`)}
            ${kpi('Hours of premieres', number.format(hours(ep.minutes)), `+ ${plural(films.length, 'film')}, ${hours(stats.films.minutes)} h`)}
            ${kpi('Notifications', number.format(stats.notifications.total), `${number.format(out.held || 0)} after quiet hours · ${number.format(lost)} lost`)}
            ${kpi('Following', number.format(following), `${plural(stats.following.series, 'series', 'series')} · ${plural(stats.following.films, 'film')} ahead`)}
        </div>
        ${box('Episodes by month', busiest, chart(stats), ' stats-chart-box')}
        <div class="stats-cols stats-cols-3">
            ${box('Genres', '', meters(stats.favourites.genres, capital))}
            ${box('Channels', '', meters(stats.favourites.networks))}
            ${box('Countries', '', meters(stats.favourites.countries, country))}
        </div>
        <div class="stats-cols stats-cols-2">
            ${box(
                'Most episodes',
                '',
                rows(ep.top.slice(0, 3).map((s) => [s.title, `${s.count} · ${hours(s.minutes)} h`])) +
                    `<h4 class="stats-box-title stats-subtitle">Films out<span>${number.format(films.length)}</span></h4>` +
                    rows(
                        [...films]
                            .sort((a, b) => b.waited - a.waited)
                            .slice(0, 3)
                            .map((f) => [f.title, f.waited ? `waited ${plural(f.waited, 'day')}` : day(f.day)]),
                        'No films out'
                    )
            )}
            ${box(
                'Bot use',
                number.format(stats.usage.total),
                rows(features.slice(0, 3), 'Not used yet') +
                    (group
                        ? `<h4 class="stats-box-title stats-subtitle">Most active members</h4>${rows(members.slice(0, 3), 'Nobody yet')}`
                        : '')
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
        ${box('Episodes by month', '', '<div class="stats-chart"></div>', ' stats-chart-box')}
        <div class="stats-cols stats-cols-3">${['Genres', 'Channels', 'Countries'].map((t) => box(t, '', meters)).join('')}</div>
        <div class="stats-cols stats-cols-2">
            ${box('Most episodes', '', list + `<h4 class="stats-box-title stats-subtitle">Films out</h4>` + list)}
            ${box('Bot use', '', list + (chatType !== 'private' ? `<h4 class="stats-box-title stats-subtitle">Most active members</h4>${list}` : ''))}
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
        body.innerHTML = `<p class="stats-failed">Failed to load: ${escapeHtml(err.message)}. Pick the period again to retry.</p>`;
    } finally {
        if (request === state.request) body.removeAttribute('aria-busy');
    }
}

/** The year the recap button shows: the period's, or this year for all time. */
const recapYear = () => (period === 'last' ? thisYear() - 1 : thisYear());

function renderRecapButton() {
    $('chat-stats-recap').textContent = `Preview ${recapYear()} recap`;
}

/** Opens the dialog for a chat, on this year. */
export function openChatStats(chat, label, back = null) {
    chatId = chat.id;
    chatName = label;
    backToMenu = back;
    chatType = chat.type || 'private';
    period = 'year';
    $('chat-stats-sub').textContent = `${label} · ${chatType}`;
    renderPeriods();
    renderRecapButton();
    $('chat-stats-recap').onclick = openRecap;
    openModal('chat-stats-modal');
    load();
}

/** A period button (data-action="chat-stats-period"). */
export function pickPeriod(key) {
    if (!chatId) return;
    period = key;
    renderPeriods();
    renderRecapButton();
    load();
}

// --- The year's recap: six PNGs drawn by the server ---

// The object URLs on show, freed when the next preview opens
let shown = [];
// The preview on screen: its chat and year, and how closing it goes back to the statistics
const preview = { id: null, year: null, back: null, sentAt: null };

function openRecap() {
    closeModal('chat-stats-modal');
    // Closing the preview goes back to the statistics, and from there to the chat's menu
    const menu = backToMenu;
    showRecap(chatId, chatName, recapYear(), () => {
        openModal('chat-stats-modal');
        if (menu) setReturnTo(menu);
    });
}

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
    $('recap-title').textContent = `${year} recap`;
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
                slot.innerHTML = `<img src="${url}" alt="Card ${n} of 6" width="1080" height="1350" />`;
            } catch (err) {
                if (request !== state.recap) return;
                slot.innerHTML = `<p class="stats-failed">Failed to load: ${escapeHtml(err.message)}</p>`;
            }
        }
    })();
}

// --- Sending this chat its year (src/recap/send.js): queued, then sent in the background ---

const when = (iso) =>
    new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

/** The preview's footer: whether this chat has its year, and the button. */
async function loadRecapStatus(request) {
    const status = $('recap-status');
    status.textContent = 'Checking whether it was sent…';
    $('recap-actions').innerHTML = '';
    try {
        const answer = await api(`/chat/${preview.id}/recap-status?year=${preview.year}`);
        if (request !== state.recap) return;
        renderRecapStatus(answer);
    } catch (err) {
        if (request !== state.recap) return;
        status.textContent = `Couldn't check whether it was sent: ${err.message}`;
    }
}

/** @param {{ status: string | null, sentAt: string | null, error: string | null }} answer */
function renderRecapStatus(answer) {
    const status = $('recap-status');
    const actions = $('recap-actions');
    const button = (label, extra = '') => `<button type="button" class="btn btn-primary"${extra}>${label}</button>`;
    if (answer.status === 'sent') {
        preview.sentAt = answer.sentAt;
        status.innerHTML = `<span class="recap-dot" aria-hidden="true"></span>Sent ${escapeHtml(when(answer.sentAt))}`;
        // Once more on purpose only: its own question says it already got it
        actions.innerHTML = `<button type="button" class="btn btn-ghost" data-action="recap-send-one" data-again="true">Send again</button>`;
        return;
    }
    if (answer.status === 'queued' || answer.status === 'sending') {
        status.textContent = "Queued: goes out shortly, or when the chat's quiet hours end.";
        actions.innerHTML = button('Queued', ' disabled');
        return;
    }
    const failed = answer.status === 'failed' ? `Failed: ${answer.error || 'unknown error'}. ` : '';
    const label = answer.status === 'failed' ? 'Send again' : 'Send to this chat';
    status.textContent = failed || 'Not sent to this chat yet.';
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
    const quiet = "In the chat's quiet hours it goes out when they end.";
    showConfirm({
        title: again ? `Send the ${year} recap again?` : `Send the ${year} recap?`,
        text: again
            ? `${chatName} already got it on ${sentAt ? when(sentAt) : 'an earlier day'}. It will get the six pictures once more. ${quiet}`
            : `Six pictures in one message to ${chatName}. This can't be undone. ${quiet}`,
        confirmLabel: again ? 'Send again' : 'Send',
        cancelLabel: 'No, cancel',
        onConfirm: async () => {
            setReturnTo(back);
            try {
                await api(`/chat/${id}/recap/send`, { method: 'POST', body: again ? { year, again: true } : { year } });
                toast('Queued: the recap goes out shortly', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            if (preview.id === id && preview.year === year) loadRecapStatus(state.recap);
        }
    });
}
