/** Names arrive localized with page data. Only card descriptions are enriched separately. */
import { api } from './api.js';
import { escapeHtml } from './dom.js';
import { t } from './i18n.js';

const validId = (id) => /^(tv|movie)_[1-9]\d{0,9}$/.test(String(id || ''));
export const catalogId = (id, kind = 'tv') =>
    validId(id)
        ? String(id)
        : /^(tv|movie)$/.test(kind) && /^[1-9]\d{0,9}$/.test(String(id || ''))
          ? `${kind}_${id}`
          : '';

// Full copy is cached on the server. Open cards share only their in-flight requests here.
const copies = new Map();
export function catalogCopy(id) {
    id = catalogId(id);
    if (!id) return Promise.reject(new Error('Bad catalog id'));
    if (!copies.has(id)) {
        const [kind, number] = id.split('_');
        copies.set(
            id,
            api(`/account/content/${kind}/${number}`).finally(() => copies.delete(id))
        );
    }
    return copies.get(id);
}

// Payload names stay authoritative even if optional browser storage contains an older translation.
export const displayTitle = (id, title) => title;
export const titleMarkup = (id, title) => {
    id = catalogId(id);
    return id ? `<span data-catalog-title="${escapeHtml(id)}">${escapeHtml(title)}</span>` : escapeHtml(title);
};
export const titleLabel = (id, key, values) => `aria-label="${escapeHtml(t(key, values))}"`;
