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
    // The session is over (or never was): session.js shows the sign-in screen
    if (res.status === 401) window.dispatchEvent(new Event('session-ended'));
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

/**
 * Sends a file as a form (multipart): the browser sets its own Content-Type with the boundary.
 * Throws like api().
 * @param {string} path Path under /api
 * @param {FormData} form
 * @returns {Promise<any>}
 */
export async function apiUpload(path, form) {
    const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'X-Requested-By': 'notfckbot-panel' },
        body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

/**
 * An image the API draws (a recap card), as a Blob: an <img> can't send the header the API asks
 * for, so the panel fetches it and shows an object URL.
 * @param {string} path Path under /api
 * @returns {Promise<Blob>}
 */
export async function apiImage(path) {
    const res = await fetch(`${API_URL}${path}`, { headers: { 'X-Requested-By': 'notfckbot-panel' } });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.blob();
}
