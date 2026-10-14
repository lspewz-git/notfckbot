/** The only place that talks to the network. */

const API_URL = '/api';

/**
 * Throws on a non-2xx status or an { error } body, so callers only ever deal
 * with the success shape and can report `err.message` as-is.
 *
 * @param {string} path Path under /api, e.g. `/data/chats`
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}) {
    const { method = 'GET', body } = options;

    const res = await fetch(`${API_URL}${path}`, {
        method,
        // The server answers only requests carrying this (src/admin/panel-only.js)
        headers: { 'Content-Type': 'application/json', 'X-Requested-By': 'notfckbot-panel' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        // The body goes along: some answers say more than the message (Settings: which field)
        const err = /** @type {Error & { status?: number, data?: any }} */ (
            new Error(data.error || `HTTP ${res.status}`)
        );
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}
