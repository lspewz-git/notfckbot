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

    if (url === cachedUrl && cachedAgent) return cachedAgent;

    cachedUrl = url;
    cachedAgent = buildProxyAgent(url);
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
    console.log(`[Proxy] Telegram client now using: ${process.env.TMDB_PROXY_URL || 'direct connection'}`);
    return true;
};

module.exports = { getProxyAgent, buildProxyAgent, applyProxyToBot };
