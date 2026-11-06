/**
 * Inside Telegram's Mini App window its own Back button (in the window's header) stands in for the
 * panel's round one, which is hidden there (html.tg-back): shown on a page that has Back (Account
 * settings, Devices, Chat settings, a nested sign-in screen), and a press does what the hidden button
 * would. Talks to the native bridge session.js found (TelegramWebviewProxy), not telegram-web-app.js:
 * https://core.telegram.org/api/web-events#web-app-setup-back-button
 */
import { dismissTopLayer } from './ui.js';

/** @type {{ postEvent: (event: string, data: string) => void } | null} */
let bridge = null;
/** @type {boolean | null} what Telegram was last told */
let shown = null;

/** The Back the current screen has: the sign-in screen's while it is up, else the open page's */
function backOfScreen() {
    const gate = document.getElementById('login-gate');
    if (gate && !gate.hidden) return document.getElementById('login-back');
    return /** @type {HTMLElement | null} */ (document.querySelector('.section.active .page-back'));
}

function pressed() {
    // A list, sheet or dialog over the page closes first, as Esc would
    if (!dismissTopLayer()) backOfScreen()?.click();
}

/** Telegram's Back button came with Bot API 6.1; an unknown version (a reload) is taken as newer */
function hasBackButton(version) {
    const [major = 0, minor = 0] = String(version || '')
        .split('.')
        .map(Number);
    return !version || major > 6 || (major === 6 && minor >= 1);
}

/**
 * The Mini App's bridge is there: hide the panel's Back and listen for Telegram's. An older Telegram
 * ignores the button silently, so there the panel keeps its own.
 * @param {string | null} [version] tgWebAppVersion from the launch fragment
 */
export function setupTelegramBack(nativeBridge, version = null) {
    if (bridge || !hasBackButton(version)) return;
    bridge = nativeBridge;
    document.documentElement.classList.add('tg-back');
    const w = /** @type {any} */ (window);
    w.Telegram ??= {};
    w.Telegram.WebView ??= {};
    // Telegram calls this for every event; anything else listening keeps getting them
    const previous = w.Telegram.WebView.receiveEvent;
    w.Telegram.WebView.receiveEvent = (event, data) => {
        if (event === 'back_button_pressed') pressed();
        if (typeof previous === 'function') previous(event, data);
    };
    syncTelegramBack();
}

/** After the screen changed: Telegram's Back shows where the screen has one. */
export function syncTelegramBack() {
    if (!bridge) return;
    const visible = Boolean(backOfScreen());
    if (visible === shown) return;
    shown = visible;
    try {
        bridge.postEvent('web_app_setup_back_button', JSON.stringify({ is_visible: visible }));
    } catch {
        // The bridge refused it: the page's own Back is the way back
        document.documentElement.classList.remove('tg-back');
    }
}
