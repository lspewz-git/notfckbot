import { locale } from './i18n.js';
import { t as i18nText } from './i18n.js';
/** The About dialog: the version the server runs (/api/version), asked for each time it opens. */

import { $, escapeHtml } from './dom.js';
import { api } from './api.js';
import { openModal } from './ui.js';

const when = (iso) =>
    new Date(iso).toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

/**
 * The version list: the commit (linked to GitHub when the repository is known), its date and
 * subject. A server without .git has nothing to tell.
 * @param {{ short: string | null, url: string | null, date: string | null, subject: string | null }} v
 */
export function renderVersion(v) {
    const list = $('about-version');
    if (!v.short) {
        list.innerHTML =
            '<dt>' +
            i18nText('Version') +
            '</dt><dd>' +
            i18nText("Unknown: Git isn't connected on the server") +
            '</dd>';
        return;
    }
    const hash = `<code>${escapeHtml(v.short)}</code>`;
    const version = v.url
        ? '<a href="' +
          escapeHtml(v.url) +
          '" target="_blank" rel="noopener noreferrer" aria-label="' +
          i18nText('Commit {{v1}} on GitHub', { v1: escapeHtml(v.short) }) +
          '">' +
          hash +
          '</a>'
        : hash;
    list.innerHTML = [
        '<dt>' + i18nText('Version') + '</dt><dd>' + version + '</dd>',
        v.date ? '<dt>' + i18nText('Date') + '</dt><dd>' + escapeHtml(when(v.date)) + '</dd>' : '',
        v.subject ? '<dt>' + i18nText('Change') + '</dt><dd>' + escapeHtml(v.subject) + '</dd>' : ''
    ].join('');
}

/** Fills the dialog in; the More sheet's row opens it itself (data-open) and calls only this. */
export async function loadAbout() {
    try {
        renderVersion(await api('/version'));
    } catch {
        $('about-version').innerHTML =
            '<dt>' +
            i18nText('Version') +
            '</dt><dd>' +
            i18nText('Failed to load. Close and open again to retry.') +
            '</dd>';
    }
}

/** The sidebar's button. */
export function openAbout() {
    openModal('about-modal');
    loadAbout();
}
