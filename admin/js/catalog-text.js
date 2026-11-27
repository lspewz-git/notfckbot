/** Localized catalog names and copy. Stored bot titles and user/chat names never change. */
import { LRUCache } from '../vendor/lru-cache.js';
import { api } from './api.js';
import { escapeHtml } from './dom.js';
import { t } from './i18n.js';

const validId = (id) => /^(tv|movie)_[1-9]\d{0,9}$/.test(String(id || ''));
// Older admin series ids are numeric; normalize only the display lookup, never the action id.
export const catalogId = (id, kind = 'tv') =>
    validId(id)
        ? String(id)
        : /^(tv|movie)$/.test(kind) && /^[1-9]\d{0,9}$/.test(String(id || ''))
          ? `${kind}_${id}`
          : '';
const names = new LRUCache({
    max: 3000,
    maxSize: 1024 * 1024,
    sizeCalculation: (name) => name.length * 2,
    ttl: 21600000
});
let active = 0;
let suspended = false;
let navigationPending = false;
/** @type {{ id: string, run: () => void, cancel: () => void }[]} */
const waiting = [];

function drain() {
    while (!suspended && !navigationPending && active < 4 && waiting.length) waiting.shift().run();
}

function request(id, urgent) {
    if (suspended) return Promise.reject(new Error('Catalog page is inactive'));
    if (waiting.length >= 128) return Promise.reject(new Error('Catalog queue is busy'));
    return new Promise((resolve, reject) => {
        const job = {
            id,
            cancel: () => reject(new Error('Catalog page is inactive')),
            run: () => {
                active++;
                const [kind, number] = id.split('_');
                api(`/account/content/${kind}/${number}`)
                    .then(resolve, reject)
                    .finally(() => {
                        active--;
                        drain();
                    });
            }
        };
        if (urgent) waiting.unshift(job);
        else waiting.push(job);
        drain();
    });
}

// Full copy already has a bounded server cache; only share requests while they are in flight here.
const copies = new Map();
let refresh = 0;

export function rememberTitle(id, title) {
    id = catalogId(id);
    if (!validId(id) || typeof title !== 'string' || !title.trim() || names.get(id) === title.trim()) return;
    names.set(id, title.trim());
    if (!refresh)
        refresh = window.setTimeout(() => {
            refresh = 0;
            for (const node of document.querySelectorAll('[data-catalog-title]')) {
                const name = names.get(node.getAttribute('data-catalog-title'));
                if (name && node.textContent !== name) node.textContent = name;
            }
            for (const node of document.querySelectorAll('[data-catalog-label-id]')) {
                const name = names.get(node.getAttribute('data-catalog-label-id'));
                if (name) {
                    const values = JSON.parse(node.getAttribute('data-catalog-label-values'));
                    node.setAttribute(
                        'aria-label',
                        t(node.getAttribute('data-catalog-label-key'), { ...values, title: name })
                    );
                }
            }
            window.dispatchEvent(new Event('catalog-names-ready'));
        }, 30);
}

export function catalogCopy(id, urgent = false) {
    id = catalogId(id);
    if (!validId(id)) return Promise.reject(new Error('Bad catalog id'));
    if (urgent) {
        const index = waiting.findIndex((job) => job.id === id);
        if (index > 0) waiting.unshift(waiting.splice(index, 1)[0]);
    }
    if (!copies.has(id)) {
        const pending = request(id, urgent)
            .then((copy) => {
                rememberTitle(id, copy.title);
                return copy;
            })
            .finally(() => copies.delete(id));
        copies.set(id, pending);
    }
    return copies.get(id);
}

export const displayTitle = (id, fallback) => names.get(catalogId(id)) || fallback;
export const titleMarkup = (id, fallback) => {
    id = catalogId(id);
    return id
        ? `<span data-catalog-title="${escapeHtml(id)}">${escapeHtml(displayTitle(id, fallback))}</span>`
        : escapeHtml(fallback);
};

/** Controlled action labels keep the user's name intact when the catalog title arrives later. */
export function titleLabel(id, key, values) {
    const label = t(key, { ...values, title: displayTitle(id, values.title) });
    return `aria-label="${escapeHtml(label)}" data-catalog-label-id="${escapeHtml(catalogId(id))}" data-catalog-label-key="${escapeHtml(key)}" data-catalog-label-values="${escapeHtml(JSON.stringify(values))}"`;
}

/** Filtering can need names outside the visible page. Stop when its query/chat changes. */
export async function warmTitles(ids, current) {
    const unique = [...new Set(ids.map((id) => catalogId(id)).filter(Boolean))];
    for (let i = 0; i < unique.length && !suspended && current(); i += 4)
        await Promise.allSettled(
            unique
                .slice(i, i + 4)
                .filter((id) => !names.has(id))
                .map((id) => catalogCopy(id))
        );
}

let observer;
let mutations;
// WebKit starts cancelling fetches before pagehide. Do not drain into the departing document.
window.addEventListener('beforeunload', () => {
    navigationPending = true;
});
// If a native unsaved-changes prompt kept this page open, interaction can safely resume its queue.
for (const event of ['pointerdown', 'keydown'])
    window.addEventListener(
        event,
        () => {
            if (!navigationPending || suspended) return;
            navigationPending = false;
            drain();
        },
        { capture: true }
    );
// A departing document must not start queued fetches as its active requests settle.
window.addEventListener('pagehide', () => {
    suspended = true;
    observer?.disconnect();
    mutations?.disconnect();
    for (const job of waiting.splice(0)) job.cancel();
});
window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    suspended = false;
    navigationPending = false;
    setupCatalogTitles();
});
const bindings = (root) => [
    ...(root.matches?.('[data-catalog-title]') ? [root] : []),
    ...(root.querySelectorAll?.('[data-catalog-title]') || [])
];

/** Only explicit catalog-name bindings are observed, including page turns and newly opened sheets. */
export function setupCatalogTitles() {
    if (!observer) {
        observer = new window.IntersectionObserver(
            (entries) => {
                for (const { target, isIntersecting } of entries) {
                    if (suspended || !isIntersecting || document.body.classList.contains('signed-out')) continue;
                    observer.unobserve(target);
                    const id = target.getAttribute('data-catalog-title');
                    const known = names.get(id);
                    if (known) {
                        target.textContent = known;
                        continue;
                    }
                    catalogCopy(id).catch(() => {
                        /* Keep the stored title; reopening can retry. */
                    });
                }
            },
            { rootMargin: '160px' }
        );
        mutations = new window.MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.removedNodes) for (const title of bindings(node)) observer.unobserve(title);
                for (const node of record.addedNodes) for (const title of bindings(node)) observer.observe(title);
            }
        });
    }
    mutations.observe(document.body, { childList: true, subtree: true });
    for (const node of document.querySelectorAll('[data-catalog-title]')) {
        observer.unobserve(node);
        observer.observe(node);
    }
}
