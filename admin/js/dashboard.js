/** The dashboard's counters, health badges, upcoming releases, update check and popularity list. */

import { $, setText, updateBadge, escapeHtml } from './dom.js';
import { isUnchanged } from './render.js';

export function updateStats(stats) {
    setText('chats-count', stats.chatsCount);
    // activeSubsCount is newer than the panel's first backend — fall back to the total
    setText('subs-count', stats.activeSubsCount ?? stats.subsCount);

    const archived = $('subs-archived-count');
    if (archived) {
        archived.hidden = !stats.archivedSubsCount;
        archived.innerText = `+ ${stats.archivedSubsCount ?? 0} archived`;
    }
    setText('films-count', stats.activeFilmsCount ?? stats.filmsCount);
    const released = $('films-released-count');
    if (released) {
        released.hidden = !stats.releasedFilmsCount;
        released.innerText = `+ ${stats.releasedFilmsCount ?? 0} released`;
    }
    setText('series-count', stats.seriesCount);
}

const KINOPOISK_HEALTH = {
    ok: ['KP: OK', 'ok'],
    error: ['KP: ERR', 'error'],
    off: ['KP: OFF', 'ghost']
};

const PROXY_HEALTH = {
    ok: ['Proxy: OK', 'ok'],
    error: ['Proxy: ERR', 'error']
};

export function updateHealth(h) {
    updateBadge('health-tg', h.telegram ? 'TG: OK' : 'TG: ERR', h.telegram ? 'ok' : 'error');
    updateBadge('health-tmdb', h.tmdb ? 'TMDB: OK' : 'TMDB: ERR', h.tmdb ? 'ok' : 'error');
    const [proxyText, proxyClass] = PROXY_HEALTH[h.proxy] || ['Proxy: OFF', 'ghost'];
    updateBadge('health-proxy', proxyText, proxyClass);

    // Kinopoisk API, used to find Kinopoisk IDs for watch links. Clicking any of
    // these badges opens the service dialog; the tooltip shows today's quota.
    const kp = KINOPOISK_HEALTH[h.kinopoisk] || KINOPOISK_HEALTH.off;
    updateBadge('health-kp', kp[0], kp[1]);
    const kpBadge = $('health-kp');
    const q = h.kinopoiskQuota;
    if (kpBadge && q) kpBadge.title = `Kinopoisk API: ${q.used} of ${q.limit} requests used today`;
}

// --- Coming up ---
const DAY = 24 * 60 * 60 * 1000;
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const KIND_ICON = {
    tv: svg('<rect x="2" y="7" width="20" height="15" rx="2" /><polyline points="17 2 12 7 7 2" />'),
    movie: svg('<rect x="2" y="2" width="20" height="20" rx="2" /><path d="M7 2v20M17 2v20M2 12h20" />')
};

/** "2026-10-16" as local midnight (not UTC), so day differences follow the viewer's calendar. */
function localDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function dayLabel(iso, today) {
    const diff = Math.round((localDay(iso) - today) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    // "Thu 15 Oct" for the coming months; "8 Jul 2027" only once the date is far enough
    // off that the month alone would be ambiguous (not for 2 Jan seen on 30 Dec)
    return diff < 180
        ? localDay(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
        : localDay(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

let upcoming = null;
// As many as Popular now lists, so the cards side by side stay the same size
const UPCOMING_SHOWN = 5;

function renderUpcoming() {
    const container = $('upcoming-list');
    if (!container || !upcoming) return;

    // The server reaches a day back (it runs in UTC); drop what is past here
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // The date is part of the signature: after midnight "Tomorrow" becomes "Today"
    if (isUnchanged('upcoming', [today.getTime(), upcoming])) return;
    const items = upcoming.filter((i) => localDay(i.date) >= today);
    if (items.length === 0) {
        container.innerHTML = '<p class="empty-note">No dates announced yet.</p>';
        return;
    }

    // The five nearest, like the five rows of Popular now
    container.innerHTML = items
        .slice(0, UPCOMING_SHOWN)
        .map((item) => {
            const what = item.kind === 'tv' ? item.episode || 'New episode' : 'Film release';
            const chats = `${item.chats} ${item.chats === 1 ? 'chat' : 'chats'}`;
            return `
        <div class="popular-item upcoming-item" data-action="${item.kind === 'tv' ? 'series' : 'film'}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0">
            <span class="upcoming-icon">${KIND_ICON[item.kind] || ''}</span>
            <div class="popular-body">
                <div class="popular-title">${escapeHtml(item.title)}</div>
                <div class="upcoming-sub">${escapeHtml(`${what} · ${chats}`)}</div>
            </div>
            <span class="upcoming-when">${escapeHtml(dayLabel(item.date, today))}</span>
        </div>`;
        })
        .join('');
}

export function updateUpcoming(list) {
    upcoming = list || [];
    renderUpcoming();
    startClock();
}

// --- Update check ---
let cron = null;
let clockTimer = null;

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
        // run and would keep the badge amber for good. They are listed under Notifications.
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

    const until = new Date(cron.nextRunAt).getTime() - now;
    setText(
        'cron-next',
        until > 0 ? `In ${duration(until)}, at ${clock(cron.nextRunAt)}` : `Due now, every ${cron.intervalHours} h`
    );
}

export function updateCron(status) {
    cron = status;
    renderCron();
    startClock();
}

// "5 min ago" and "Today" have to keep moving even while auto-refresh is paused
function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(() => {
        renderCron();
        renderUpcoming();
    }, 30_000);
}

export function updatePopular(list) {
    if (isUnchanged('popular', list)) return;

    const container = $('popular-list');
    if (!list || list.length === 0) {
        container.innerHTML = '<p class="empty-note">No data yet.</p>';
        return;
    }

    container.innerHTML = list
        .map((item, idx) => {
            const count = Number(item.subCount) || 0;
            return `
        <div class="popular-item" data-action="series" data-id="${item.seriesId}" role="button" tabindex="0">
            <div class="popular-rank">${idx + 1}</div>
            <div class="popular-body">
                <div class="popular-title">${escapeHtml(item.Series.title)}</div>
            </div>
            <div class="popular-count">
                <span class="popular-value">${count}</span>
                <span class="popular-sub">${count === 1 ? 'subscriber' : 'subscribers'}</span>
            </div>
        </div>
    `;
        })
        .join('');
}
