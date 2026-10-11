/** The dashboard's counters, health badges and popularity list. */

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
    setText('films-count', stats.filmsCount);
    setText('series-count', stats.seriesCount);
}

const PROXY_HEALTH = {
    ok: ['Proxy: OK', 'ok'],
    error: ['Proxy: ERR', 'error']
};

export function updateHealth(h) {
    updateBadge('health-tg', h.telegram ? 'TG: OK' : 'TG: ERR', h.telegram ? 'ok' : 'error');
    updateBadge('health-tmdb', h.tmdb ? 'TMDB: OK' : 'TMDB: ERR', h.tmdb ? 'ok' : 'error');
    const [proxyText, proxyClass] = PROXY_HEALTH[h.proxy] || ['Proxy: OFF', 'ghost'];
    updateBadge('health-proxy', proxyText, proxyClass);
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
