import { t as i18nText } from './i18n.js';
/**
 * The proxy URL in parts, and the proxy test's result in words: for the proxy dialog (proxy.js)
 * and Settings (settings.js). No DOM, no requests.
 */

/**
 * The URL from its parts; '' with no scheme (no proxy) or without a host and a port. Shared with
 * Settings, which edits the same value.
 * @param {{ scheme: string, host: string, port: string, user?: string, pass?: string }} parts
 */
export function composeProxyUrl({ scheme, host, port, user = '', pass = '' }) {
    if (!scheme || !host.trim() || !String(port).trim()) return '';
    const name = user.trim();
    const auth = name ? `${encodeURIComponent(name)}${pass ? ':' + encodeURIComponent(pass) : ''}@` : '';
    return `${scheme}://${auth}${host.trim()}:${String(port).trim()}`;
}

const DEFAULT_PORTS = { http: '80', https: '443' };

/** The parts of a saved URL (the server never sends the password); null for one that can't be read. */
export function parseProxyUrl(url) {
    if (!url) return { scheme: '', host: '', port: '', user: '' };
    try {
        const parsed = new URL(url);
        const scheme = parsed.protocol.replace(':', '');
        return {
            scheme,
            host: parsed.hostname,
            // URL drops a scheme's default port ("http://h:80" has port ""): put it back, or the
            // form would show an empty port and refuse to save
            port: parsed.port || DEFAULT_PORTS[scheme] || '',
            user: decodeURIComponent(parsed.username || '')
        };
    } catch {
        return null;
    }
}

const TARGET_NAMES = { telegram: 'Telegram', tmdb: 'TMDB', internet: i18nText('Internet') };

/**
 * "Telegram ✓ 180 ms · TMDB ✗ replied 503 · Internet ✓ 95 ms (IP 1.2.3.4)", or the proxy's own
 * failure when nothing got through. All fine: success; some: a warning; none: an error.
 * @param {{ direct: boolean, proxyDown: string | null, checks: Record<string, { ok: boolean, ms: number, error?: string, ip?: string }> }} res
 */
export function describeTest(res) {
    const via = res.direct ? i18nText('Direct connection') : i18nText('Proxy');
    if (res.proxyDown)
        return { text: i18nText('{{v0}} unreachable: {{v1}}', { v0: via, v1: res.proxyDown }), type: 'error' };
    const checks = Object.entries(res.checks);
    const parts = checks.map(([name, c]) => {
        const label = TARGET_NAMES[name] || name;
        if (!c.ok) return `${label} ✗ ${c.error}`;
        return i18nText('{{v0}} ✓ {{v1}} ms{{v2}}', { v0: label, v1: c.ms, v2: c.ip ? ` (IP ${c.ip})` : '' });
    });
    const passed = checks.filter(([, c]) => c.ok).length;
    const type = passed === checks.length ? 'success' : passed ? 'warning' : 'error';
    return { text: `${via}: ${parts.join(' · ')}`, type };
}
