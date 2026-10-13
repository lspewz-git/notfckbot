/**
 * The API answers the panel's own page only. Without it, any site open in a browser on the home
 * network could call http://<server>/api/… and read the data, send messages to chats or clear
 * the database: being on a LAN doesn't help when the request comes from the user's own browser.
 *
 * - The panel marks every request with PANEL_HEADER (admin/js/api.js). A page on another site
 *   can't add a custom header to a request here: the browser would first ask the server
 *   (a CORS preflight), and the server allows no other origin. An address typed into the
 *   browser's address bar has no such header either.
 * - The Host must be the server's own address (an IP, or a local name like "cinema-bot"). This
 *   stops DNS rebinding, where a site points its own domain at this server's IP to pass for it.
 *
 * Posters are left open: <img> can't send headers, and they are TMDB's public images.
 */
const PANEL_HEADER = 'x-requested-by';
const PANEL_VALUE = 'notfckbot-panel';
const OPEN_PATHS = /^\/api\/poster\//;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Names that can't be bought on the internet: no dot at all, or a home-network suffix
const LOCAL_NAME = /^[a-z0-9-]+$|\.(local|lan|home\.arpa|internal)$/i;

/** "192.168.2.112:80" → "192.168.2.112", "[::1]:3000" → "::1" */
function hostName(host) {
    const value = String(host || '').trim();
    if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
    return value.replace(/:\d+$/, '');
}

function isLocalHost(host) {
    const name = hostName(host);
    if (!name) return false;
    return IPV4.test(name) || name.includes(':') || LOCAL_NAME.test(name);
}

/** @returns {string | null} why the request is refused, or null */
function refusal(req) {
    if (!isLocalHost(req.headers.host)) return 'Unknown host';
    const origin = req.headers.origin;
    if (origin) {
        let originHost = null;
        try {
            originHost = new URL(origin).host;
        } catch {
            // "null" (a sandboxed frame) and anything malformed
        }
        if (originHost !== req.headers.host) return 'Cross-origin request';
    }
    // Mounted at /api, so req.path alone lacks it
    if (OPEN_PATHS.test((req.baseUrl || '') + req.path)) return null;
    if (req.headers[PANEL_HEADER] !== PANEL_VALUE) return 'The API answers the admin panel only';
    return null;
}

function panelOnly(req, res, next) {
    const reason = refusal(req);
    if (!reason) return next();
    console.warn(`[Admin] Refused ${req.method} ${req.originalUrl}: ${reason} (origin ${req.headers.origin || '-'})`);
    res.status(403).json({ error: reason });
}

module.exports = { panelOnly, refusal, isLocalHost, PANEL_HEADER, PANEL_VALUE };
