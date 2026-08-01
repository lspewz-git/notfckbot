/** The dashboard's counters, health badges and popularity list. */

import { $, setText, updateBadge, escapeHtml } from './dom.js';
import { isUnchanged } from './render.js';

export function updateStats(stats) {
    setText('chats-count', stats.chatsCount);
    setText('subs-count', stats.subsCount);
    setText('films-count', stats.filmsCount);
}

const PROXY_HEALTH = {
    ok: ['Proxy: OK', 'ok'],
    error: ['Proxy: ERR', 'error']
};

export function updateHealth(h) {
    updateBadge('health-tg', h.telegram ? 'TG: OK' : 'TG: ERR', h.telegram ? 'ok' : 'error');
    updateBadge('health-tmdb', h.tmdb ? 'TMDB: OK' : 'TMDB: ERR', h.tmdb ? 'ok' : 'error');
    updateBadge('health-proxy', ...(PROXY_HEALTH[h.proxy] || ['Proxy: OFF', 'ghost']));
}

export function updatePopular(list) {
    if (isUnchanged('popular', list)) return;

    const container = $('popular-list');
    if (!list || list.length === 0) {
        container.innerHTML = '<p class="empty-note">No data yet.</p>';
        return;
    }

    container.innerHTML = list.map((item, idx) => `
        <div class="popular-item" data-action="series" data-id="${item.seriesId}">
            <div class="popular-rank">${idx + 1}</div>
            <div class="popular-body">
                <div class="popular-title">${escapeHtml(item.Series.title)}</div>
                <div class="popular-sub">${item.subCount} subscribers</div>
            </div>
            <div class="popular-chevron">›</div>
        </div>
    `).join('');
}
