const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Single source of truth for the outbound proxy.
 *
 * Everything the container initiates — TMDB and the Telegram Bot API — goes
 * through the agent built here. The MariaDB connection deliberately does not:
 * it stays inside the docker network.
 *
 * DNS note: http(s) proxies resolve the hostname themselves (CONNECT carries
 * the name), and so does socks5h. Plain socks5 resolves locally first.
 */

let cachedAgent = null;
let cachedUrl = null;

const PROXY_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'];

/**
 * Why a proxy URL can't be used, or null when it can ('' — no proxy — can). Checked before a
 * value is saved: the agents throw on a URL they can't parse, and with such a value in .env
 * the bot would fail on every start.
 */
function proxyUrlProblem(url) {
    if (!url) return null;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return 'Proxy URL is not valid: check the host and the port (1–65535)';
    }
    if (!PROXY_PROTOCOLS.includes(parsed.protocol)) {
        return 'Proxy URL must start with http://, https://, socks4://, socks5:// or socks5h://';
    }
    if (!parsed.hostname) return 'Proxy URL has no host';
    return null;
}

/** Build an agent for an arbitrary URL. Returns null for an unusable value. */
const buildProxyAgent = (url) => {
    if (!url) return null;
    if (url.startsWith('socks')) return new SocksProxyAgent(url, { rejectUnauthorized: false });
    if (url.startsWith('http')) return new HttpsProxyAgent(url, { rejectUnauthorized: false });
    return null;
};

/**
 * Agent for the currently configured TMDB_PROXY_URL, or null when the proxy is
 * off. Cached per URL — rebuilding it on every request leaks sockets and shows
 * up as ECONNRESET.
 */
const getProxyAgent = () => {
    const url = process.env.TMDB_PROXY_URL;

    if (!url) {
        cachedAgent = null;
        cachedUrl = null;
        return null;
    }

    if (url === cachedUrl) return cachedAgent;

    cachedUrl = url;
    try {
        cachedAgent = buildProxyAgent(url);
    } catch (err) {
        // A hand-edited .env: better a direct connection (and this line in the log, once per
        // value) than a bot that fails on start and every request that throws
        console.error(`[Proxy] TMDB_PROXY_URL can't be used (${err.message}); connecting directly`);
        cachedAgent = null;
    }
    return cachedAgent;
};

/**
 * Re-point an existing Telegraf client at the current proxy setting, so the
 * admin panel can switch proxies without a restart.
 */
const applyProxyToBot = (bot) => {
    if (!bot || !bot.telegram || !bot.telegram.options) {
        console.error('[Proxy] Could not reach the Telegram client options — restart to apply.');
        return false;
    }

    bot.telegram.options.agent = getProxyAgent();
    // Logs are readable in the admin panel, so never print the password
    console.log(
        `[Proxy] Telegram client now using: ${redactProxyUrl(process.env.TMDB_PROXY_URL) || 'direct connection'}`
    );
    return true;
};

/** The proxy URL without its password, for anything that leaves the server. */
function redactProxyUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        u.password = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return url.replace(/:[^:@/]*@/, '@');
    }
}

const hasProxyPassword = (url) => {
    try {
        return Boolean(url && new URL(url).password);
    } catch {
        return false;
    }
};

/**
 * The panel never receives the saved password, so a form sent back with the
 * password left empty means "keep it": put the saved one back, as long as it is
 * for the same user on the same host.
 */
function withSavedPassword(newUrl, savedUrl) {
    if (!newUrl || !savedUrl) return newUrl;
    try {
        const next = new URL(newUrl);
        const saved = new URL(savedUrl);
        if (next.password || !saved.password) return newUrl;
        if (next.username !== saved.username || next.host !== saved.host) return newUrl;
        next.password = saved.password;
        return next.toString().replace(/\/$/, '');
    } catch {
        return newUrl;
    }
}

module.exports = {
    getProxyAgent,
    proxyUrlProblem,
    buildProxyAgent,
    applyProxyToBot,
    redactProxyUrl,
    hasProxyPassword,
    withSavedPassword
};
