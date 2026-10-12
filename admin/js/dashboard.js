/** The dashboard: counters, service statuses and the error banner, upcoming releases, popularity, the update check. */

import { $, setText, updateBadge, escapeHtml } from './dom.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { isUnchanged } from './render.js';

export function updateStats(stats) {
    setText('chats-count', stats.chatsCount);
    // activeSubsCount is newer than the panel's first backend — fall back to the total
    setText('subs-count', stats.activeSubsCount ?? stats.subsCount);

    const archived = $('subs-archived-count');
    if (archived) {
        archived.hidden = !stats.archivedSubsCount;
        archived.innerText = `+${stats.archivedSubsCount ?? 0} archived`;
    }
    setText('films-count', stats.activeFilmsCount ?? stats.filmsCount);
    const released = $('films-released-count');
    if (released) {
        released.hidden = !stats.releasedFilmsCount;
        released.innerText = `+${stats.releasedFilmsCount ?? 0} released`;
    }
    setText('series-count', stats.seriesCount);
}

// --- Service statuses ---
// A dot and a short label: "TG" when fine, "KP: ERR" when not, "Proxy: OFF" when unused

/** ok | error | off per service, for the banner; a service not yet answered is absent */
const serviceState = {};
const SERVICE_NAMES = { telegram: 'TG', tmdb: 'TMDB', kinopoisk: 'KP', proxy: 'Proxy' };

function setService(key, badgeId, state) {
    serviceState[key] = state;
    const name = SERVICE_NAMES[key];
    const [text, cls] =
        state === 'ok' ? [name, 'ok'] : state === 'error' ? [`${name}: ERR`, 'error'] : [`${name}: OFF`, 'ghost'];
    updateBadge(badgeId, text, cls);
}

/** "KP is reporting an error" / "KP and TMDB are reporting errors"; hidden when all is well. */
function renderServiceAlert() {
    const banner = $('service-alert');
    if (!banner) return;
    const failing = Object.keys(SERVICE_NAMES)
        .filter((k) => serviceState[k] === 'error')
        .map((k) => SERVICE_NAMES[k]);
    banner.hidden = failing.length === 0;
    if (!failing.length) return;
    const names =
        failing.length === 1 ? failing[0] : `${failing.slice(0, -1).join(', ')} and ${failing[failing.length - 1]}`;
    const text = `${names} ${failing.length === 1 ? 'is reporting an error' : 'are reporting errors'}`;
    // The banner is a live region: rewriting the same words would make screen readers repeat them
    const el = $('service-alert-text');
    if (el.textContent !== text) el.textContent = text;
}

/** Takes all of /api/health or one service's part of it; updates only the statuses it covers. */
export function updateHealth(h) {
    if ('telegram' in h) setService('telegram', 'health-tg', h.telegram ? 'ok' : 'error');
    if ('tmdb' in h) setService('tmdb', 'health-tmdb', h.tmdb ? 'ok' : 'error');
    if ('proxy' in h) setService('proxy', 'health-proxy', h.proxy === 'ok' || h.proxy === 'error' ? h.proxy : 'off');

    // Kinopoisk API, used to find Kinopoisk IDs for watch links. Clicking a status opens
    // the service dialog; the tooltip shows today's quota.
    if ('kinopoisk' in h) {
        setService('kinopoisk', 'health-kp', h.kinopoisk === 'ok' || h.kinopoisk === 'error' ? h.kinopoisk : 'off');
        const kpBadge = $('health-kp');
        const q = h.kinopoiskQuota;
        if (kpBadge)
            kpBadge.title = q
                ? `Kinopoisk API: ${q.used} of ${q.limit} requests used today`
                : 'Kinopoisk API: key, quota and status';
    }
    renderServiceAlert();
}

// --- Coming up ---
const DAY = 24 * 60 * 60 * 1000;
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const KIND_ICON = {
    tv: svg('<rect x="2" y="7" width="20" height="15" rx="2" /><polyline points="17 2 12 7 7 2" />'),
    movie: svg(
        '<rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 12h18M3 7.5h4M3 16.5h4M17 7.5h4M17 16.5h4" />'
    )
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
        day: day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        sub:
            day.getFullYear() === today.getFullYear()
                ? day.toLocaleDateString('en-GB', { weekday: 'short' })
                : String(day.getFullYear())
    };
}

/** "today", "tomorrow", "in 3 days", "in 2 weeks", "in 9 months", "in 1 year", "in 2 years" */
function relativeDay(iso, today) {
    const diff = Math.round((localDay(iso).getTime() - today.getTime()) / DAY);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff < 14) return `in ${diff} days`;
    if (diff < 60) return `in ${Math.round(diff / 7)} weeks`;
    // Months up to a year and a half; beyond that whole years read better than "in 20 months"
    if (diff < 548) return `in ${Math.round(diff / 30.4)} months`;
    const years = Math.round(diff / 365);
    return `in ${years} ${years === 1 ? 'year' : 'years'}`;
}

let upcoming = null;
// As many as Popular now lists, so the two panels side by side match
const UPCOMING_SHOWN = 5;

// One builder per list for both the real rows and their placeholders, so a placeholder
// always has the real row's structure (and therefore its height on every screen size)
const bar = (width, sub = false) =>
    `<span class="skeleton${sub ? ' skeleton-sub' : ''}" style="width:${width}"></span>`;
const PLACEHOLDER_WIDTHS = ['62%', '48%', '70%', '55%', '40%'];

/** @param {{ attrs?: string, placeholder?: boolean, date: string, icon?: string, title: string, meta: string, when: string }} r */
const upcomingRow = (r) => `
        <div class="upcoming-row${r.placeholder ? ' skeleton-item' : ''}" ${r.placeholder ? 'aria-hidden="true"' : r.attrs}>
            <div class="up-date">${r.date}</div>
            <span class="up-icon">${r.icon || ''}</span>
            <div class="up-body"><div class="up-title">${r.title}</div><div class="up-meta">${r.meta}</div></div>
            <span class="up-when">${r.when}</span>
        </div>`;

/** @param {{ attrs?: string, placeholder?: boolean, rank: string, title: string, count: string }} r */
const popularRow = (r) => `
        <div class="popular-item${r.placeholder ? ' skeleton-item' : ''}" ${r.placeholder ? 'aria-hidden="true"' : r.attrs}>
            <span class="pop-rank">${r.rank}</span>
            <span class="pop-title">${r.title}</span>
            <span class="pop-count">${r.count}</span>
        </div>`;

/** Five placeholder rows in each list, so the cards have their final size before the data. */
export function renderDashboardPlaceholders() {
    $('upcoming-list').innerHTML = PLACEHOLDER_WIDTHS.map((w) =>
        upcomingRow({ placeholder: true, date: bar('52px'), title: bar(w), meta: bar('30%', true), when: bar('56px') })
    ).join('');
    $('popular-list').innerHTML = PLACEHOLDER_WIDTHS.map((w) =>
        popularRow({ placeholder: true, rank: '', title: bar(w), count: '' })
    ).join('');
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
        container.innerHTML = '<p class="empty-note">No dates announced yet.</p>';
        return;
    }

    container.innerHTML = items
        .slice(0, UPCOMING_SHOWN)
        .map((item) => {
            const what = item.kind === 'tv' ? item.episode || 'New episode' : 'Film release';
            const chats = `${item.chats} ${item.chats === 1 ? 'chat' : 'chats'}`;
            const { day, sub } = dateParts(item.date, today);
            return upcomingRow({
                attrs: `data-action="${item.kind === 'tv' ? 'series' : 'film'}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0"`,
                date: `<span class="up-day">${escapeHtml(day)}</span><span class="up-weekday">${escapeHtml(sub)}</span>`,
                icon: KIND_ICON[item.kind],
                title: escapeHtml(item.title),
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
        container.innerHTML = '<p class="empty-note">No data yet.</p>';
        return;
    }

    container.innerHTML = list
        .map((item, idx) => {
            const count = Number(item.subCount) || 0;
            return popularRow({
                attrs: `data-action="series" data-id="${escapeHtml(item.seriesId)}" role="button" tabindex="0"`,
                rank: String(idx + 1),
                title: escapeHtml(item.Series.title),
                count: `<b>${count}</b> ${count === 1 ? 'subscriber' : 'subscribers'}`
            });
        })
        .join('');
}

// --- Version ---
/** "Version 6638430 · 12 Oct, 17:15", the hash linked to the commit; the subject as a tooltip. */
export function updateVersion(v) {
    const el = $('build-info');
    if (!el || isUnchanged('version', v)) return;
    el.hidden = !v.short;
    if (!v.short) return;
    const hash = `<code>${escapeHtml(v.short)}</code>`;
    const link = v.url
        ? `<a href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer" aria-label="Commit ${escapeHtml(v.short)} on GitHub">${hash}</a>`
        : hash;
    const when = v.date
        ? ` · ${escapeHtml(new Date(v.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}`
        : '';
    el.innerHTML = `Version ${link}${when}`;
    el.title = v.subject || '';
}

// --- Update check ---
let cron = null;
let clockTimer = null;
// Set while "Run now" waits for the check it started
let runPending = false;

/** 41 s, 12 min, 2 h 5 min */
function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function renderRunButton() {
    const btn = /** @type {HTMLButtonElement} */ ($('run-check'));
    if (!btn) return;
    const busy = runPending || Boolean(cron && cron.running);
    btn.disabled = busy;
    btn.textContent = busy ? 'Running…' : 'Run now';
}

function renderCron() {
    if (!cron) return;
    const now = Date.now();
    const last = cron.lastRun;
    const state = $('cron-state');

    if (cron.running) {
        updateBadge('cron-state', 'Running', 'warn');
        setText('cron-last', `Running now, started ${duration(now - new Date(cron.startedAt).getTime())} ago`);
    } else if (!last) {
        updateBadge('cron-state', 'Not run yet', 'muted');
        setText('cron-last', 'No check since the bot started');
    } else {
        // Undelivered messages are not counted: a chat that blocked the bot fails on every
        // run and would keep the state amber for good. They are listed under Notifications.
        const problems = (last.errors || 0) + (last.fatal ? 1 : 0);
        if (last.fatal) updateBadge('cron-state', 'Failed', 'error');
        else if (problems) updateBadge('cron-state', `${problems} ${problems === 1 ? 'error' : 'errors'}`, 'warn');
        else updateBadge('cron-state', 'OK', 'ok');
        setText(
            'cron-last',
            `${duration(now - new Date(last.finishedAt).getTime())} ago, took ${duration(last.durationMs)}`
        );
    }
    if (state) state.title = last && last.fatal ? `Last check failed: ${last.fatal}` : '';

    if (last) {
        const errors = last.errors ? `, ${last.errors} ${last.errors === 1 ? 'error' : 'errors'}` : '';
        setText('cron-checked', `${last.series} series, ${last.films} films${errors}`);
        // Usually a chat that blocked the bot or was deleted
        const failed = last.failed ? `, ${last.failed} not delivered` : '';
        setText('cron-sent', `${last.sent} sent${failed}`);
    } else {
        setText('cron-checked', '—');
        setText('cron-sent', '—');
    }

    // The server's schedule, independent of the panel's auto-refresh
    const until = new Date(cron.nextRunAt).getTime() - now;
    setText(
        'cron-next',
        until > 0 ? `In ${duration(until)}, at ${clock(cron.nextRunAt)}` : `Due now, every ${cron.intervalHours} h`
    );
    setText('series-interval', `Checked every ${cron.intervalHours} hours`);
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
        if (running) toast('The update check is still running; the dashboard will show it when it ends', 'info');
        else toast('Update check finished', 'success');
    } catch (e) {
        toast(`Update check failed to start: ${e.message}`, 'error');
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
