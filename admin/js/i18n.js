import i18next from '../vendor/i18next.js';
import russian from '../locales/ru.js';

const PREFERENCE_KEY = 'nfb.language';
const TELEGRAM_KEY = 'nfb.telegram-language';
const preferences = ['auto', 'en', 'ru'];

export const normalizeLanguage = (value) => (typeof value === 'string' && /^ru(?:[-_]|$)/i.test(value) ? 'ru' : 'en');

/** @param {'localStorage' | 'sessionStorage'} storage @param {string} key */
function read(storage, key) {
    try {
        return window[storage].getItem(key);
    } catch {
        return null;
    }
}
/** @param {'localStorage' | 'sessionStorage'} storage @param {string} key @param {string} value */
function store(storage, key, value) {
    try {
        window[storage].setItem(key, value);
    } catch {
        /* Storage is optional, including in private mode. */
    }
}

/** Only native Telegram launches use Telegram metadata; a browser URL cannot change that source. */
function detection() {
    const native = /** @type {any} */ (window).TelegramWebviewProxy;
    if (typeof native?.postEvent === 'function') {
        const url = new URL(location.href);
        const hint = url.searchParams.get('telegramLanguage');
        let code = ['en', 'ru'].includes(hint) ? hint : read('sessionStorage', TELEGRAM_KEY);
        try {
            const data = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData');
            const user = data && new URLSearchParams(data).get('user');
            const fresh = user && JSON.parse(user).language_code;
            if (typeof fresh === 'string' && /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i.test(fresh)) {
                code = fresh;
                store('sessionStorage', TELEGRAM_KEY, code);
            }
        } catch {
            /* Invalid optional launch metadata falls back to the browser. */
        }
        if (code) {
            const language = normalizeLanguage(code);
            // A native-only cosmetic hint survives reload even when browser storage is blocked.
            url.searchParams.set('telegramLanguage', language);
            window.history.replaceState(window.history.state, '', url);
            return { language, source: 'Telegram language' };
        }
    }
    return { language: normalizeLanguage(navigator.languages?.[0] || navigator.language), source: 'Browser language' };
}

export const detectedLanguage = detection();
const suppliedPreference = new URL(location.href).searchParams.get('panelLanguage');
let preference = preferences.includes(suppliedPreference) ? suppliedPreference : read('localStorage', PREFERENCE_KEY);
if (!preferences.includes(preference)) preference = 'auto';
export const language = preference === 'auto' ? detectedLanguage.language : preference;
export const locale = language === 'ru' ? 'ru-RU' : 'en-GB';

i18next.init({
    lng: language,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ru'],
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    resources: {
        en: {
            translation: {
                '{{count}} season_one': '{{count}} season',
                '{{count}} season_other': '{{count}} seasons',
                '{{count}} chat_one': '{{count}} chat',
                '{{count}} chat_other': '{{count}} chats',
                '{{count}} error_one': '{{count}} error',
                '{{count}} error_other': '{{count}} errors',
                day_one: 'day',
                day_other: 'days',
                hour_one: 'hour',
                hour_other: 'hours',
                minute_one: 'minute',
                minute_other: 'minutes',
                '{{count}} unsaved change_one': '{{count}} unsaved change',
                '{{count}} unsaved change_other': '{{count}} unsaved changes'
            }
        },
        ru: { translation: russian }
    }
});

/** Source phrases are the English fallback. Values must be escaped by the HTML caller, as usual. */
export const t = (key, values = {}) => String(i18next.t(key, values));
export const languagePreference = () => preference;

/** Called before showing a signed-in page. A reload also rebuilds module-level translated labels. */
export function accountLanguage(value, resume = null) {
    const next = preferences.includes(value) ? value : 'auto';
    preference = next;
    store('localStorage', PREFERENCE_KEY, next);
    const resolved = next === 'auto' ? detectedLanguage.language : next;
    if (resolved === language) return true;
    // A query value carries only this cosmetic preference when storage is unavailable.
    const url = new URL(location.href);
    url.searchParams.set('panelLanguage', next);
    if (resume?.chatId)
        url.hash = new URLSearchParams({
            panelLaunch: JSON.stringify({ ...resume, expiresAt: Date.now() + 120000 })
        }).toString();
    location.replace(url.href);
    return false;
}

/** A one-use navigation hint across our language reload, never an authorization grant. */
export function languageLaunch(value, userId) {
    try {
        if (!value || value.length > 1024) return null;
        const saved = JSON.parse(value);
        if (
            saved.userId !== String(userId) ||
            !/^-?\d{1,20}$/.test(saved.chatId || '') ||
            !Number.isFinite(saved.expiresAt) ||
            saved.expiresAt < Date.now() ||
            saved.expiresAt > Date.now() + 120000 ||
            (saved.title && !/^(tv|movie)_[1-9]\d{0,9}$/.test(saved.title))
        )
            return null;
        return saved;
    } catch {
        return null;
    }
}

/** Explicitly tagged first-party HTML only; API titles, names and descriptions are never scanned. */
export function translatePage(root = document) {
    document.documentElement.lang = language;
    for (const element of root.querySelectorAll('[data-i18n]'))
        element.textContent = t(element.getAttribute('data-i18n'));
    for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
        for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`))
            element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
}
