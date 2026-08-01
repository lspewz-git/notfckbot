/**
 * TMDB proxy settings.
 *
 * The value is stored as a single URL in TMDB_PROXY_URL; this form edits it as
 * parts and composes/parses it on the way in and out.
 */

import { $ } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { toast, openModal, closeModal } from './ui.js';
import { setSelectValue } from './select.js';

const FIELDS = ['proxy-host', 'proxy-port', 'proxy-user', 'proxy-pass'];

function urlFromForm() {
    const scheme = $('proxy-scheme').value;
    if (!scheme) return '';

    const host = $('proxy-host').value.trim();
    const port = $('proxy-port').value.trim();
    if (!host || !port) return '';

    const user = $('proxy-user').value.trim();
    const pass = $('proxy-pass').value;
    const auth = user
        ? `${encodeURIComponent(user)}${pass ? ':' + encodeURIComponent(pass) : ''}@`
        : '';

    return `${scheme}://${auth}${host}:${port}`;
}

function syncForm() {
    const scheme = $('proxy-scheme').value;
    $('proxy-fields').style.display = scheme ? 'block' : 'none';

    const url = urlFromForm();
    // Never echo the password back into the UI
    $('proxy-preview').innerText = url ? url.replace(/:([^:@/]+)@/, ':•••@') : '—';
}

function fillForm(url) {
    const clear = () => FIELDS.forEach(id => { $(id).value = ''; });

    if (!url) {
        setSelectValue('proxy-scheme', '');
        clear();
        return syncForm();
    }

    try {
        const parsed = new URL(url);
        setSelectValue('proxy-scheme', parsed.protocol.replace(':', ''));
        $('proxy-host').value = parsed.hostname;
        $('proxy-port').value = parsed.port;
        $('proxy-user').value = decodeURIComponent(parsed.username || '');
        $('proxy-pass').value = decodeURIComponent(parsed.password || '');
    } catch (e) {
        // Hand-edited .env value we can't parse — start from a clean form
        toast('Stored proxy URL could not be parsed', 'warning');
        setSelectValue('proxy-scheme', '');
        clear();
    }

    syncForm();
}

export async function openProxyModal() {
    openModal('proxy-modal');
    try {
        const cfg = await api('/config');
        fillForm(cfg.tmdbProxyUrl || '');
    } catch (e) {
        toast('Could not load current proxy settings', 'error');
    }
}

/** Both buttons need the same "is the form usable" check first. */
function urlOrWarn() {
    const scheme = $('proxy-scheme').value;
    const url = urlFromForm();
    if (scheme && !url) {
        toast('Fill in host and port first', 'warning');
        return null;
    }
    return url;
}

export function setupProxyForm() {
    FIELDS.forEach(id => $(id).addEventListener('input', syncForm));
    $('proxy-scheme').addEventListener('change', syncForm);

    $('proxy-test').onclick = async (e) => {
        const url = urlOrWarn();
        if (url === null) return;

        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerText = 'Testing...';
        try {
            // Reachability failures come back as an { error } body, which api()
            // turns into a throw — so both paths land in the catch below.
            const res = await api('/config/test-proxy', { method: 'POST', body: { url } });
            toast(`${res.direct ? 'Direct connection' : 'Proxy'} reached TMDB in ${res.ms} ms`, 'success');
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
