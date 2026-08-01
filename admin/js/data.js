/** What gets fetched, when, and what happens after a mutating call. */

import { api } from './api.js';
import { toast } from './ui.js';
import { renderTable, renderSkeleton, renderTableMessage } from './tables.js';
import { updateStats, updateHealth, updatePopular } from './dashboard.js';
import { setLogs, renderLogs } from './logs.js';

// Which /api/data/:type each section needs, if any
const SECTION_TABLES = {
    chats: 'chats',
    subs: 'subs',
    watchlist: 'films'
};

let currentSection = 'dashboard';
export const setSection = (id) => {
    currentSection = id;
};

// Tables that have received a response at least once
const loadedTables = new Set();

/**
 * Requests only what the visible section renders. This matters more than it
 * looks: /api/health probes Telegram and TMDB over the network on every call,
 * and it used to run every 10s regardless of which page was open.
 */
export async function fetchData() {
    // Started before the awaits below so its skeleton paints in this same tick
    const table = SECTION_TABLES[currentSection];
    if (table) fetchTypedData(table);

    const jobs = [];
    if (currentSection === 'dashboard') {
        jobs.push(api('/stats').then(updateStats));
        jobs.push(api('/health').then(updateHealth));
        jobs.push(api('/stats/popular').then(updatePopular));
    }
    if (currentSection === 'logs') {
        jobs.push(
            api('/logs').then((logs) => {
                setLogs(logs);
                renderLogs();
            })
        );
    }

    const results = await Promise.allSettled(jobs);
    results.forEach((r) => {
        if (r.status === 'rejected') console.error('Fetch error:', r.reason);
    });
}

async function fetchTypedData(type) {
    // Only on the first load of this table: the 10s poll would otherwise
    // replace real rows with a shimmer every time it fires.
    if (!loadedTables.has(type)) renderSkeleton(type);

    try {
        const data = await api(`/data/${type}`);
        loadedTables.add(type);
        renderTable(type, data);
    } catch (err) {
        console.error(`Error loading ${type}:`, err);
        // Leave a dead end rather than an animation that never stops
        if (!loadedTables.has(type)) renderTableMessage(type, 'Failed to load. Retrying on the next refresh.');
    }
}

/**
 * A mutating call plus the three things that always follow it: report the
 * outcome, refresh the view, hand back the payload (null if it failed).
 * `success` may be a string or a function of the response.
 */
export async function mutate(path, options, success) {
    try {
        const data = await api(path, options);
        if (success) toast(typeof success === 'function' ? success(data) : success, 'success');
        fetchData();
        return data;
    } catch (e) {
        toast(e.message || 'Request failed', 'error');
        return null;
    }
}
