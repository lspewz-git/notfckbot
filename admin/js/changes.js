/**
 * A chat's change log (src/chat-changes.js): who changed its list or settings, from where and when,
 * with a search and pages. The panel shows it in a dialog (English), a group's admins under its
 * settings on the account pages (English too, for now).
 */

import { escapeHtml, debounce } from './dom.js';
import { api } from './api.js';
import { enhanceIn } from './select.js';
import { PAGE_SIZES } from './pager.js';

const SIZE_KEY = 'admin.pageSize.changes';

const WORDS = {
    en: {
        locale: 'en-GB',
        search: 'Search by title or name',
        rows: 'Rows per page',
        of: 'of',
        prev: 'Previous page',
        next: 'Next page',
        empty: 'No changes',
        nothingFound: 'Nothing found',
        failed: 'Failed to load',
        kept: (days) => `Kept for ${days} days`,
        source: { panel: 'panel', account: 'account', bot: '' },
        modes: { episode: 'every episode', season: 'whole season', first_and_full: '1st + season' },
        line: {
            subscribed: (t) => `Subscribed: ${t}`,
            mode: (t, mode) => `${t}: now ${mode}`,
            unsubscribed: (t) => `Unsubscribed: ${t}`,
            film_added: (t) => `Film added: ${t}`,
            film_removed: (t) => `Film removed: ${t}`,
            bot_on: () => 'Bot added or started',
            bot_off: () => 'Bot removed or stopped'
        }
    },
    ru: {
        locale: 'ru-RU',
        search: 'Поиск по названию или имени',
        rows: 'Строк на странице',
        of: 'из',
        prev: 'Назад',
        next: 'Дальше',
        empty: 'Изменений пока нет',
        nothingFound: 'Ничего не нашлось',
        failed: 'Не удалось загрузить',
        kept: (days) => `Хранится ${days} дн.`,
        source: { panel: 'панель', account: 'сайт', bot: '' },
        modes: { episode: 'каждая серия', season: 'весь сезон', first_and_full: '1-я + сезон' },
        line: {
            subscribed: (t) => `Подписка: ${t}`,
            mode: (t, mode) => `${t}: теперь ${mode}`,
            unsubscribed: (t) => `Отписка: ${t}`,
            film_added: (t) => `Фильм добавлен: ${t}`,
            film_removed: (t) => `Фильм убран: ${t}`,
            bot_on: () => 'Бота добавили или запустили',
            bot_off: () => 'Бота убрали или остановили'
        }
    }
};

function storedSize() {
    try {
        const n = Number(localStorage.getItem(SIZE_KEY));
        return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
    } catch {
        return PAGE_SIZES[0];
    }
}

// Per log path: { page, q }, so a reload (a setting changed) keeps the page and the search
const views = new Map();
// Per root: its latest load, for the listeners set once
const loaders = new WeakMap();

/** What happened, in words; a settings row has its own line already (in Russian, as the bot says it). */
function lineOf(row, words) {
    if (row.kind === 'settings') return row.title || row.detail || '';
    const make = words.line[row.kind];
    const title = row.title || '—';
    if (!make) return title;
    return make(title, words.modes[row.detail] || row.detail || '');
}

function metaOf(row, words) {
    const at = new Date(row.at).toLocaleString(words.locale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });
    const from = words.source[row.source] || '';
    return [at, row.userName, from].filter(Boolean).join(' · ');
}

function listHtml(data, view, words) {
    if (!data.rows.length) return `<p class="changes-empty">${view.q ? words.nothingFound : words.empty}</p>`;
    return `<ul class="changes-list">${data.rows
        .map(
            (row) =>
                `<li class="changes-row"><span class="changes-meta">${escapeHtml(metaOf(row, words))}</span><span class="changes-line">${escapeHtml(lineOf(row, words))}</span></li>`
        )
        .join('')}</ul>`;
}

/** The parts that stay while pages change: the search field keeps its focus and caret. */
function frame(root, view, words) {
    const size = storedSize();
    root.innerHTML = `
        <input class="input-field changes-search" type="search" value="${escapeHtml(view.q)}"
            placeholder="${words.search}" aria-label="${words.search}" autocomplete="off" />
        <div class="changes-body" aria-live="polite"></div>
        <div class="pager changes-pager" hidden>
            <div class="pager-size">
                <span class="pager-label">${words.rows}</span>
                <select class="select-field" data-changes-size aria-label="${words.rows}">
                    ${PAGE_SIZES.map((n) => `<option value="${n}"${n === size ? ' selected' : ''}>${n}</option>`).join('')}
                </select>
            </div>
            <span class="pager-info"></span>
            <div class="pager-nav">
                <button type="button" class="btn btn-ghost btn-icon" data-changes-step="-1" aria-label="${words.prev}">
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <button type="button" class="btn btn-ghost btn-icon" data-changes-step="1" aria-label="${words.next}">
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </button>
            </div>
        </div>
        <p class="changes-kept"></p>`;
    enhanceIn(root);
}

/**
 * Shows a chat's log in `root` and keeps it working: search, page size, arrows.
 * @param {HTMLElement} root
 * @param {{ path: string, lang?: 'en' | 'ru' }} options path: the API path without ?…
 */
export function showChanges(root, { path, lang = 'en' }) {
    const words = WORDS[lang];
    if (!views.has(path)) views.set(path, { page: 1, q: '' });
    const view = views.get(path);
    let asked = 0;

    const load = async () => {
        const ask = ++asked;
        const size = storedSize();
        const body = /** @type {HTMLElement} */ (root.querySelector('.changes-body'));
        body.setAttribute('aria-busy', 'true');
        try {
            const query = new URLSearchParams({ page: String(view.page), size: String(size), q: view.q });
            const data = await api(`${path}?${query}`);
            // A newer search or page asked meanwhile, or the root shows another chat now
            if (ask !== asked || root.dataset.changesPath !== path) return;
            const pages = Math.max(1, Math.ceil(data.total / size));
            if (view.page > pages) {
                view.page = pages;
                return load();
            }
            body.innerHTML = listHtml(data, view, words);
            const pager = /** @type {HTMLElement} */ (root.querySelector('.changes-pager'));
            pager.hidden = data.total <= PAGE_SIZES[0];
            const start = (view.page - 1) * size;
            pager.querySelector('.pager-info').textContent =
                `${start + 1}–${Math.min(start + size, data.total)} ${words.of} ${data.total}`;
            root.querySelectorAll('[data-changes-step]').forEach((el) => {
                const btn = /** @type {HTMLButtonElement} */ (el);
                btn.disabled = Number(btn.dataset.changesStep) < 0 ? view.page <= 1 : view.page >= pages;
            });
            root.querySelector('.changes-kept').textContent = words.kept(data.keepDays);
        } catch (err) {
            if (ask === asked)
                body.innerHTML = `<p class="changes-empty">${words.failed}: ${escapeHtml(err.message)}</p>`;
        } finally {
            if (ask === asked) body.removeAttribute('aria-busy');
        }
    };

    frame(root, view, words);
    // A root may be shown again (another chat, a reload): its listeners are set once, and read the latest load
    loaders.set(root, load);
    if (!root.dataset.changesBound) {
        root.dataset.changesBound = 'true';
        const search = debounce(() => loaders.get(root)(), 300);
        root.addEventListener('input', (e) => {
            const input = /** @type {HTMLInputElement} */ (e.target);
            if (!input.classList.contains('changes-search')) return;
            const current = views.get(root.dataset.changesPath);
            current.q = input.value;
            current.page = 1;
            search();
        });
        root.addEventListener('change', (e) => {
            const select = /** @type {HTMLSelectElement} */ (e.target);
            if (!select.matches('[data-changes-size]')) return;
            try {
                localStorage.setItem(SIZE_KEY, select.value);
            } catch {
                // A private window: the size lasts while the page is open
            }
            views.get(root.dataset.changesPath).page = 1;
            loaders.get(root)();
        });
        root.addEventListener('click', (e) => {
            const btn = /** @type {HTMLElement} */ (e.target).closest('[data-changes-step]');
            if (!btn) return;
            const current = views.get(root.dataset.changesPath);
            current.page = Math.max(1, current.page + Number(/** @type {HTMLElement} */ (btn).dataset.changesStep));
            loaders.get(root)();
        });
    }
    root.dataset.changesPath = path;
    return load();
}
