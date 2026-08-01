/** The only place that talks to the network. */

const API_URL = '/api';

/** @returns {Record<string, string>} */
function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Admin-Token': localStorage.getItem('adminToken') || ''
    };
}

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
        headers: getHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
