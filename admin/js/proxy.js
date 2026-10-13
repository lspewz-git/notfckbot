/**
 * TMDB proxy settings.
 *
 * The value is stored as a single URL in TMDB_PROXY_URL; this form edits it as
 * parts and composes/parses it on the way in and out.
 */

import { $, $field, target } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { toast, openModal, closeModal } from './ui.js';
import { setSelectValue } from './select.js';

const FIELDS = ['proxy-host', 'proxy-port', 'proxy-user', 'proxy-pass'];

function urlFromForm() {
    const scheme = $field('proxy-scheme').value;
    if (!scheme) return '';

    const host = $field('proxy-host').value.trim();
    const port = $field('proxy-port').value.trim();
    if (!host || !port) return '';

    const user = $field('proxy-user').value.trim();
    const pass = $field('proxy-pass').value;
    const auth = user ? `${encodeURIComponent(user)}${pass ? ':' + encodeURIComponent(pass) : ''}@` : '';

    return `${scheme}://${auth}${host}:${port}`;
}

function syncForm() {
    const scheme = $field('proxy-scheme').value;
    $('proxy-fields').style.display = scheme ? 'block' : 'none';

    const url = urlFromForm();
    // Never echo the password back into the UI
    $('proxy-preview').innerText = url ? url.replace(/:([^:@/]+)@/, ':•••@') : '—';
}

function fillForm(url) {
    const clear = () =>
        FIELDS.forEach((id) => {
            $field(id).value = '';
        });

    if (!url) {
        setSelectValue('proxy-scheme', '');
        clear();
        return syncForm();
    }

    try {
        const parsed = new URL(url);
        setSelectValue('proxy-scheme', parsed.protocol.replace(':', ''));
        $field('proxy-host').value = parsed.hostname;
        $field('proxy-port').value = parsed.port;
        $field('proxy-user').value = decodeURIComponent(parsed.username || '');
        // The server never sends the password; an empty field keeps the saved one
        $field('proxy-pass').value = '';
    } catch (e) {
        // Hand-edited .env value we can't parse — start from a clean form
        toast('Stored proxy URL could not be parsed', 'warning');
        setSelectValue('proxy-scheme', '');
        clear();
    }

    syncForm();
}

export async function openProxyModal() {
    // Fill the form before showing it: opening first and filling after made the
    // host/port fields flash in and collapse once the saved mode arrived
    try {
        const cfg = await api('/config');
        fillForm(cfg.tmdbProxyUrl || '');
        $field('proxy-pass').placeholder = cfg.proxyHasPassword ? '•••••• saved — leave empty to keep' : '';
    } catch (e) {
        toast('Could not load current proxy settings', 'error');
        syncForm();
    }
    openModal('proxy-modal');
}

const TARGET_NAMES = { telegram: 'Telegram', tmdb: 'TMDB', internet: 'Internet' };

/**
 * "Telegram ✓ 180 ms · TMDB ✗ replied 503 · Internet ✓ 95 ms (IP 1.2.3.4)", or the proxy's own
 * failure when nothing got through. All fine: success; some: a warning; none: an error.
 * @param {{ direct: boolean, proxyDown: string | null, checks: Record<string, { ok: boolean, ms: number, error?: string, ip?: string }> }} res
 */
export function describeTest(res) {
    const via = res.direct ? 'Direct connection' : 'Proxy';
    if (res.proxyDown) return { text: `${via} unreachable: ${res.proxyDown}`, type: 'error' };
    const checks = Object.entries(res.checks);
    const parts = checks.map(([name, c]) => {
        const label = TARGET_NAMES[name] || name;
        if (!c.ok) return `${label} ✗ ${c.error}`;
        return `${label} ✓ ${c.ms} ms${c.ip ? ` (IP ${c.ip})` : ''}`;
    });
    const passed = checks.filter(([, c]) => c.ok).length;
    const type = passed === checks.length ? 'success' : passed ? 'warning' : 'error';
    return { text: `${via}: ${parts.join(' · ')}`, type };
}

/** Both buttons need the same "is the form usable" check first. */
function urlOrWarn() {
    const scheme = $field('proxy-scheme').value;
    const url = urlFromForm();
    if (scheme && !url) {
        toast('Fill in host and port first', 'warning');
        return null;
    }
    return url;
}

export function setupProxyForm() {
    FIELDS.forEach((id) => $(id).addEventListener('input', syncForm));
    $field('proxy-scheme').addEventListener('change', syncForm);

    $('proxy-test').onclick = async (e) => {
        const url = urlOrWarn();
        if (url === null) return;

        const btn = target(e);
        btn.disabled = true;
        btn.innerText = 'Testing...';
        try {
            // A URL the server refuses comes back as an { error } body, which api() turns into
            // a throw; otherwise each target has its own result
            const res = await api('/config/test-proxy', { method: 'POST', body: { url } });
            const { text, type } = describeTest(res);
            toast(text, type, 8000);
        } catch (err) {
            toast(`Failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Test';
        }
    };

    $('proxy-save').onclick = async () => {
        const url = urlOrWarn();
        if (url === null) return;

        const ok = await mutate(
            '/config',
            { method: 'POST', body: { tmdbProxyUrl: url } },
            url ? 'Proxy enabled' : 'Proxy disabled — connecting directly'
        );
        if (ok) closeModal('proxy-modal');
    };
}
