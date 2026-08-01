/** The activity log viewer. */

import { $ } from './dom.js';
import { isUnchanged } from './render.js';

const FILTERS = {
    all: () => true,
    error: (l) => l.type === 'error' || l.text.includes('❌'),
    success: (l) => l.text.includes('✅')
};

let entries = [];
let activeFilter = 'all';

export const setLogs = (logs) => { entries = logs; };

export function renderLogs() {
    // The filter is part of the signature — switching it must re-render
    if (isUnchanged('logs', [activeFilter, entries])) return;

    const viewer = $('logs-viewer');
    const matches = FILTERS[activeFilter] || FILTERS.all;

    // Only stick to the bottom if the reader is already there; otherwise the
    // poll would yank them back down mid-scroll.
    const atBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 40;

    viewer.innerHTML = entries.filter(matches).map(l => `
        <div class="log-entry ${l.type}">
            <span class="log-time">${l.time}</span>
            <span class="type-tag">${l.type}</span>
            <span class="log-text">${l.text}</span>
        </div>
    `).join('');

    if (atBottom) viewer.scrollTop = viewer.scrollHeight;
}

export function filterLogs(type) {
    activeFilter = type;
    document.querySelectorAll('.log-filters .btn').forEach(b => {
        b.classList.toggle('active', b.dataset.logFilter === type);
    });
    renderLogs();
}
