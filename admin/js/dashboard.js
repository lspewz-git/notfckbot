import { locale } from './i18n.js';
import { t as i18nText } from './i18n.js';
import { titleMarkup } from './catalog-text.js';
/** The dashboard: counters, service statuses and the error banner, upcoming releases, popularity, the update check. */

import { $, all, setText, updateBadge, escapeHtml } from './dom.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { isUnchanged } from './render.js';
import { sinceText } from './service-health.js';

/**
 * A card's change: an arrow and the number, then what it compares with. Green when the change
 * is good news, amber (the logo's colour) when it isn't, grey when nothing changed.
 * @param {string} id
 * @param {number} change
 * @param {string} text "new in 30 days", "from the week before"
 * @param {string} flat what to say when nothing changed
 * @param {'up' | 'down'} goodWhen which way is good news
 */
function setDelta(id, change, text, flat, goodWhen = 'up') {
    const el = $(id);
    if (!el) return;
    const n = Number(change) || 0;
    // Only these classes: the element may carry its own (the card's line style)
    const state = !n ? 'delta-flat' : n > 0 === (goodWhen === 'up') ? 'delta-good' : 'delta-bad';
    el.classList.add('delta');
    el.classList.remove('delta-flat', 'delta-good', 'delta-bad');
    el.classList.add(state);
    if (!n) {
        el.textContent = flat;
        return;
    }
    el.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${n > 0 ? 'trending-up' : 'trending-down'}" /></svg>`;
    const strong = document.createElement('b');
    strong.textContent = `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
    el.append(strong, ` ${text}`);
}

/** "· 8 archived": an aside after the change, hidden when there is none. */
function setAside(id, n, text) {
    const el = $(id);
    if (!el) return;
    el.hidden = !n;
    el.textContent = `${n ?? 0} ${text}`;
}

export function updateStats(stats) {
    setText('chats-count', stats.chatsCount);
    setDelta('chats-delta', stats.chatsNew30, i18nText('new in 30 days'), i18nText('None new in 30 days'));
    // Blocked the bot or took it out of the group
    setAside('chats-left-count', stats.chatsLeft, 'left');
    // activeSubsCount is newer than the panel's first backend — fall back to the total
    setText('subs-count', stats.activeSubsCount ?? stats.subsCount);
    setDelta('subs-delta', stats.subsNew30, i18nText('new in 30 days'), i18nText('None new in 30 days'));
    setAside('subs-archived-count', stats.archivedSubsCount, 'archived');
    setText('films-count', stats.activeFilmsCount ?? stats.filmsCount);
    // Added minus released: how the waiting list changed
    setDelta(
        'films-delta',
        (stats.filmsAdded30 || 0) - (stats.filmsReleased30 || 0),
        i18nText('in 30 days'),
        i18nText('No change in 30 days')
    );
    setAside('films-released-count', stats.releasedFilmsCount, 'released');
    setText('series-count', stats.seriesCount);
    setText('sent-count', stats.sent7 ?? 0);
    setDelta(
        'sent-delta',
        (stats.sent7 || 0) - (stats.sentPrev7 || 0),
        i18nText('from the week before'),
        i18nText('Same as the week before')
    );
    setText('failed-count', stats.failed7 ?? 0);
    setDelta(
        'failed-delta',
        (stats.failed7 || 0) - (stats.failedPrev7 || 0),
        i18nText('from the week before'),
        i18nText('Same as the week before'),
        'down'
    );
}

// --- Service statuses ---
// A dot and a short label: "TG" when fine, "KP: ERR" when not, "Proxy: OFF" when unused

/** ok | error | off per service, for the banner; a service not yet answered is absent */
const serviceState = {};
/** The problem the server reports per service while it fails: { since, reason, checks } */
const serviceProblem = {};
const SERVICE_NAMES = { telegram: 'TG', tmdb: 'TMDB', tvmaze: 'TVmaze', kinopoisk: 'KP', proxy: i18nText('Proxy') };
// The badge of each service; clicking one opens its dialog
const SERVICE_BADGES = {
    telegram: 'health-tg',
    tmdb: 'health-tmdb',
    tvmaze: 'health-tvmaze',
    kinopoisk: 'health-kp',
    proxy: 'health-proxy'
};

function setService(key, badgeId, state) {
    serviceState[key] = state;
    const name = SERVICE_NAMES[key];
    const [text, cls] =
        state === 'ok'
            ? [name, 'ok']
            : state === 'error'
              ? [i18nText('{{v0}}: ERR', { v0: name }), 'error']
              : [i18nText('{{v0}}: OFF', { v0: name }), 'ghost'];
    updateBadge(badgeId, text, cls);
}

/**
 * "KP is reporting an error" / "KP and TMDB are reporting errors"; hidden when all is well.
 * Its button opens the (first) failing service's dialog, which shows why.
 */
function renderServiceAlert() {
    const banner = $('service-alert');
    if (!banner) return;
    const failingKeys = Object.keys(SERVICE_NAMES).filter((k) => serviceState[k] === 'error');
    const failing = failingKeys.map((k) => SERVICE_NAMES[k]);
    banner.hidden = failing.length === 0;
    if (!failing.length) return;
    const action = $('service-alert-action');
    action.textContent = i18nText('Open {{v0}}', { v0: failing[0] });
    action.dataset.badge = SERVICE_BADGES[failingKeys[0]];
    const names =
        failing.length === 1
            ? failing[0]
            : i18nText('{{v0}} and {{v1}}', { v0: failing.slice(0, -1).join(', '), v1: failing[failing.length - 1] });
    // One service: why and since when ("Proxy is reporting an error: timeout · since 22:37")
    const problem = failing.length === 1 ? serviceProblem[failingKeys[0]] : null;
    const text =
        failing.length > 1
            ? i18nText('{{v0}} are reporting errors', { v0: names })
            : i18nText('{{v0}} is reporting an error{{v1}}', {
                  v0: names,
                  v1: problem ? `: ${problem.reason} · ${sinceText(problem)}` : ''
              });
    // The banner is a live region: rewriting the same words would make screen readers repeat them
    const el = $('service-alert-text');
    if (el.textContent !== text) el.textContent = text;
}

/** Takes all of /api/health or one service's part of it; updates only the statuses it covers. */
/** The banner's button: the same as clicking the failing service's badge. */
export function openFailingService() {
    const badge = $($('service-alert-action').dataset.badge || '');
    if (badge) badge.click();
}

export function updateHealth(h) {
    // A single service's answer carries its problem; the all-services one doesn't
    if ('problem' in h) {
        const key = Object.keys(SERVICE_NAMES).find((k) => k in h);
        if (key) serviceProblem[key] = h.problem;
    }
    if ('telegram' in h) setService('telegram', 'health-tg', h.telegram ? 'ok' : 'error');
    if ('tmdb' in h) setService('tmdb', 'health-tmdb', h.tmdb ? 'ok' : 'error');
    if ('tvmaze' in h) setService('tvmaze', 'health-tvmaze', h.tvmaze ? 'ok' : 'error');
    if ('proxy' in h) setService('proxy', 'health-proxy', h.proxy === 'ok' || h.proxy === 'error' ? h.proxy : 'off');

    // Kinopoisk API, used to find Kinopoisk IDs for watch links. Clicking a status opens
    // the service dialog; the tooltip shows today's quota.
    if ('kinopoisk' in h) {
        setService('kinopoisk', 'health-kp', h.kinopoisk === 'ok' || h.kinopoisk === 'error' ? h.kinopoisk : 'off');
        const kpBadge = $('health-kp');
        const q = h.kinopoiskQuota;
        if (kpBadge)
            kpBadge.title = q
                ? i18nText('Kinopoisk API: {{v0}} of {{v1}} requests used today', { v0: q.used, v1: q.limit })
                : i18nText('Kinopoisk API: key, quota and status');
    }
    renderServiceAlert();
}

// --- Coming up ---
const DAY = 24 * 60 * 60 * 1000;
const svg = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const KIND_ICON = {
    tv: svg('tv'),
    movie: svg('film')
};

/** "2026-10-16" as local midnight (not UTC), so day differences follow the viewer's calendar. */
function localDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/** The date column: "15 Oct" over "Thu"; a date in another year shows the year instead. */
function dateParts(iso, today) {
    const day = localDay(iso);
    return {
        day: day.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
        sub:
            day.getFullYear() === today.getFullYear()
                ? day.toLocaleDateString(locale, { weekday: 'short' })
                : String(day.getFullYear())
    };
}

/** "today", "tomorrow", "in 3 days", "in 2 weeks", "in 9 months", "in 1 year", "in 2 years" */
function relativeDay(iso, today) {
    const diff = Math.round((localDay(iso).getTime() - today.getTime()) / DAY);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff < 14) return i18nText('in {{v0}} days', { v0: diff });
    if (diff < 60) return i18nText('in {{v0}} weeks', { v0: Math.round(diff / 7) });
    // Months up to a year and a half; beyond that whole years read better than "in 20 months"
    if (diff < 548) return i18nText('in {{v0}} months', { v0: Math.round(diff / 30.4) });
    const years = Math.round(diff / 365);
    return i18nText('in {{v0}} {{v1}}', { v0: years, v1: years === 1 ? 'year' : 'years' });
}

let upcoming = null;
// As many as Popular now lists, so the two panels side by side match
const UPCOMING_SHOWN = 5;

// The placeholder rows are in index.html (they show with the first paint): a row here keeps their
// structure, and tests/dashboard.spec.js checks the two match in shape and height
/** @param {{ attrs: string, date: string, icon?: string, title: string, meta: string, when: string }} r */
const upcomingRow = (r) => `
        <div class="upcoming-row" ${r.attrs}>
            <div class="up-date">${r.date}</div>
            <span class="up-icon">${r.icon || ''}</span>
            <div class="up-body"><div class="up-title">${r.title}</div><div class="up-meta">${r.meta}</div></div>
            <span class="up-when">${r.when}</span>
        </div>`;

/** @param {{ attrs: string, rank: string, title: string, count: string }} r */
const popularRow = (r) => `
        <div class="popular-item" ${r.attrs}>
            <span class="pop-rank">${r.rank}</span>
            <span class="pop-title">${r.title}</span>
            <span class="pop-count">${r.count}</span>
        </div>`;

// A request that fails before its first answer: the page's placeholders give way to a dead end
// rather than shimmering on for ever (as the tables do); the next refresh fills them in
const FAILED_NOTE = '<p class="empty-note">' + i18nText('Failed to load. Retrying on the next refresh.') + '</p>';

/** /api/stats failed: a dash where a number has never come. */
export function statsFailed() {
    all('.stat-value .skeleton').forEach((el) => el.replaceWith('-'));
}

/** /api/upcoming or /api/stats/popular failed: a note where the list has never come. */
export function listFailed(id) {
    const container = $(id);
    if (!container || !container.querySelector('.skeleton-item')) return;
    container.innerHTML = FAILED_NOTE;
    container.removeAttribute('aria-busy');
}

function renderUpcoming() {
    const container = $('upcoming-list');
    if (!container || !upcoming) return;
    container.removeAttribute('aria-busy');

    // The server reaches a day back (it runs in UTC); drop what is past here
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // The date is part of the signature: after midnight "tomorrow" becomes "today"
    if (isUnchanged('upcoming', [today.getTime(), upcoming])) return;
    const items = upcoming.filter((i) => localDay(i.date) >= today);
    if (items.length === 0) {
        container.innerHTML = '<p class="empty-note">' + i18nText('No dates announced yet.') + '</p>';
        return;
    }

    container.innerHTML = items
        .slice(0, UPCOMING_SHOWN)
        .map((item) => {
            const what = item.kind === 'tv' ? item.episode || i18nText('New episode') : i18nText('Film release');
            const chats = i18nText('{{count}} chat', { count: item.chats });
            const { day, sub } = dateParts(item.date, today);
            return upcomingRow({
                attrs: `data-action="${item.kind === 'tv' ? 'series' : 'film'}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0"`,
                date: `<span class="up-day">${escapeHtml(day)}</span><span class="up-weekday">${escapeHtml(sub)}</span>`,
                icon: KIND_ICON[item.kind],
                title: titleMarkup(item.id, item.title),
                meta: escapeHtml(`${what} · ${chats}`),
                when: escapeHtml(relativeDay(item.date, today))
            });
        })
        .join('');
}

export function updateUpcoming(list) {
    upcoming = list || [];
    renderUpcoming();
    startClock();
}

// --- Popular now ---
export function updatePopular(list) {
    if (isUnchanged('popular', list)) return;

    const container = $('popular-list');
    container.removeAttribute('aria-busy');
    if (!list || list.length === 0) {
        container.innerHTML = '<p class="empty-note">' + i18nText('No data yet.') + '</p>';
        return;
    }

    container.innerHTML = list
        .map((item, idx) => {
            const count = Number(item.subCount) || 0;
            return popularRow({
                attrs: `data-action="series" data-id="${escapeHtml(item.seriesId)}" role="button" tabindex="0"`,
                rank: String(idx + 1),
                title: titleMarkup(item.seriesId, item.Series.title),
                count: `<b>${count}</b> ${count === 1 ? 'subscriber' : 'subscribers'}`
            });
        })
        .join('');
}

// --- Update check ---
let cron = null;
let clockTimer = null;
// Set while "Run now" waits for the check it started
let runPending = false;

/** 41 s, 12 min, 2 h 5 min */
function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return i18nText('{{v0}} s', { v0: s });
    const m = Math.round(s / 60);
    if (m < 60) return i18nText('{{v0}} min', { v0: m });
    const h = Math.floor(m / 60);
    return m % 60 ? i18nText('{{v0}} h {{v1}} min', { v0: h, v1: m % 60 }) : i18nText('{{v0}} h', { v0: h });
}

const clock = (iso) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

function renderRunButton() {
    const btn = /** @type {HTMLButtonElement} */ ($('run-check'));
    if (!btn) return;
    const busy = runPending || Boolean(cron && cron.running);
    btn.disabled = busy;
    btn.textContent = busy ? i18nText('Running…') : i18nText('Run now');
}

function renderCron() {
    if (!cron) return;
    const now = Date.now();
    const last = cron.lastRun;
    const state = $('cron-state');

    if (cron.running) {
        const elapsed = duration(now - new Date(cron.startedAt).getTime());
        updateBadge('cron-state', i18nText('Running'), 'warn');
        setText('cron-last', i18nText('Running now, started {{v0}} ago', { v0: elapsed }));
        setText('cron-duration', i18nText('{{v0}} so far', { v0: elapsed }));
    } else if (!last) {
        updateBadge('cron-state', i18nText('Not run yet'), 'muted');
        setText('cron-last', i18nText('No check since the bot started'));
        setText('cron-duration', '—');
    } else {
        // Undelivered messages are not counted: a chat that blocked the bot fails on every
        // run and would keep the state amber for good. They are listed under Notifications.
        const problems = (last.errors || 0) + (last.fatal ? 1 : 0);
        if (last.fatal) updateBadge('cron-state', i18nText('Failed'), 'error');
        else if (problems) updateBadge('cron-state', i18nText('{{count}} error', { count: problems }), 'warn');
        else updateBadge('cron-state', 'OK', 'ok');
        setText('cron-last', i18nText('{{v0}} ago', { v0: duration(now - new Date(last.finishedAt).getTime()) }));
        setText('cron-duration', duration(last.durationMs));
    }
    if (state) state.title = last && last.fatal ? i18nText('Last check failed: {{v0}}', { v0: last.fatal }) : '';

    if (last) {
        const errors = last.errors ? ', ' + i18nText('{{count}} error', { count: last.errors }) : '';
        setText(
            'cron-checked',
            i18nText('{{v0}} series, {{v1}} films{{v2}}', { v0: last.series, v1: last.films, v2: errors })
        );
        // Usually a chat that blocked the bot or was deleted
        const failed = last.failed ? i18nText(', {{v0}} not delivered', { v0: last.failed }) : '';
        setText('cron-sent', i18nText('{{v0}} sent{{v1}}', { v0: last.sent, v1: failed }));
    } else {
        setText('cron-checked', '—');
        setText('cron-sent', '—');
    }

    // The server's schedule, independent of the panel's auto-refresh
    const until = new Date(cron.nextRunAt).getTime() - now;
    setText(
        'cron-next',
        until > 0
            ? i18nText('In {{v0}}, at {{v1}}', { v0: duration(until), v1: clock(cron.nextRunAt) })
            : i18nText('Due now, every {{v0}} h', { v0: cron.intervalHours })
    );
    const hours = cron.intervalHours;
    setText(
        'series-interval',
        hours === 1 ? i18nText('Checked every hour') : i18nText('Checked every {{v0}} hours', { v0: hours })
    );
    renderRunButton();
}

export function updateCron(status) {
    cron = status;
    renderCron();
    startClock();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts an update check and follows it to the end, then refreshes the dashboard.
 * @param {() => Promise<unknown>} refresh reloads the dashboard's data
 */
export async function runCheckNow(refresh) {
    if (runPending) return;
    runPending = true;
    renderRunButton();
    try {
        await api('/trigger-check', { method: 'POST' });
        // A check takes seconds to a few minutes; stop watching after ten, and say so honestly
        let running = true;
        for (let i = 0; i < 300 && running; i++) {
            await sleep(2000);
            const status = await api('/cron');
            updateCron(status);
            running = status.running;
        }
        if (running)
            toast(i18nText('The update check is still running; the dashboard will show it when it ends'), 'info');
        else toast(i18nText('Update check finished'), 'success');
    } catch (e) {
        toast(i18nText('Update check failed to start: {{v0}}', { v0: e.message }), 'error');
    } finally {
        runPending = false;
        renderRunButton();
        await refresh();
    }
}

// "5 min ago" and "today" have to keep moving even while auto-refresh is paused
function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(() => {
        renderCron();
        renderUpcoming();
    }, 30_000);
}
