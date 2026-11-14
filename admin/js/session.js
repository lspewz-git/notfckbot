/**
 * Who is using the panel (src/account/auth.js). Without a session the sign-in screens cover it
 * (SIGNIN.md, 13.11): the ways in, then one screen per way. "Continue with Telegram", the QR code
 * and a personal password wait for «Да, это я» in the bot, which shows the same six digits as the
 * page; "Bot code" waits for those digits sent to the bot. Besides them: the link from
 * login-link.js on the server (/login/<token>, spent only by the press of "Sign in"). With a
 * session, an admin gets the whole panel and a user (body.role-user) only their own chats.
 *
 * Layout: below 720px a phone's (the actions at the bottom, a way's screen full height), from 720px a
 * card in the middle (440 wide); the QR code is a way like the others, on a phone and a computer alike.
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { toast } from './ui.js';
import { setChats, chatsFailed, resetChatChoice, setLaunchTitle } from './account.js';
import { signInForm, submitSignIn, setMe, loginAlert, setLoginAlert, syncSignInButton } from './password.js';
import { setProfile } from './profile.js';
import { setupTelegramBack, syncTelegramBack } from './tg-back.js';

const POLL_MS = 1500;
const POLL_FOR_MS = 5 * 60 * 1000;
// The first screen gets a new code this close to the old one's end, so its link never lapses
const RENEW_AT_S = 5;

/** A Lucide icon from the local sprite (names are constants here, never data). */
const icon = (name, cls = '') =>
    `<svg class="icon${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const SPINNER = icon('loader-circle', 'login-spin');

const BRAND =
    `<div class="login-brand"><div class="rail-logo login-logo" aria-hidden="true">${icon('clapperboard')}</div>` +
    '<h1 id="login-title" tabindex="-1">NotFckBot</h1></div>';

const TERMS_NOTE =
    '<p class="login-terms-note">By continuing, you agree to the <button type="button" class="login-terms-link" data-action="login-terms">Terms of Service</button>.</p>';

/** A way's screen: the round Back to the ways in, then its title. */
const stepHead = (title) =>
    `<button type="button" id="login-back" class="login-back" data-action="login-cancel" aria-label="Back to sign-in options">${icon('chevron-left')}</button>` +
    `<h1 id="login-step" class="login-step-title" tabindex="-1">${title}</h1>`;

const ANOTHER_WAY = '<button type="button" class="login-text-btn" data-action="login-cancel">Use another way</button>';

/** m:ss of whole seconds. */
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** "482 913" for the eye, "Code 4 8 2 9 1 3" for a screen reader. */
const digits = (check) =>
    `<span class="sr-only">Code ${escapeHtml(String(check).split('').join(' '))}</span>` +
    `<span class="login-digits-value" aria-hidden="true">${escapeHtml(String(check).replace(/^(\d{3})(\d{3})$/, '$1 $2'))}</span>`;

// The first check of the session has answered: a 401 before it is that check's own, not an ended session
let started = false;
// Each new screen or try: an older one's answer still on its way is for nobody when it lands
let attempt = 0;
/** What the panel does once a sign-in went through (set by sessionActions) */
let finish = async () => {};

/** A nested screen opened: focus on its Back */
const focusStep = () => $('login-back')?.focus();

/**
 * Draws a sign-in screen. Kinds: 'start' (the ways in), 'step' (one way's screen), 'link' (the logo
 * and one action: a sign-in link), 'fail' (a failure with its HTTP status).
 */
const gate = (html, kind) => {
    $('login-body').innerHTML = `<div class="login-screen login-${kind}">${html}</div>`;
    $('login-gate').hidden = false;
    document.body.classList.add('signed-out');
    syncTelegramBack();
};

// Saved to the iPhone home screen: iOS opens an https t.me link in an in-app Safari sheet that shows
// t.me's "Start bot" page instead of the app, and the sheet stays over the panel afterwards. There the
// link goes straight to the Telegram app with its own scheme, in the same window (no sheet).
const homeScreenApp = () => /** @type {Navigator & { standalone?: boolean }} */ (navigator).standalone === true;

/** The bot link for this device: `tg://resolve?domain=<bot>[&start=<code>]` in a home-screen app. */
function botLink(url) {
    if (!homeScreenApp()) return url;
    try {
        const link = new URL(url);
        const domain = link.pathname.slice(1);
        const start = link.searchParams.get('start');
        if (link.hostname !== 't.me' || !domain) return url;
        return `tg://resolve?domain=${encodeURIComponent(domain)}${start ? `&start=${encodeURIComponent(start)}` : ''}`;
    } catch {
        return url;
    }
}

/** Link attributes for the bot link: a new tab in a browser, the same window for the app's scheme. */
const botTarget = () => (homeScreenApp() ? '' : ' target="_blank" rel="noopener noreferrer"');

/** The bot's @name from a t.me link, or null. */
function botName(url) {
    try {
        const link = new URL(url);
        const name = link.pathname.slice(1);
        return link.hostname === 't.me' && /^\w{3,64}$/.test(name) ? name : null;
    } catch {
        return null;
    }
}

// --- One challenge watched: its countdown every second and its poll every 1.5 s, both paused while
// the page is hidden (a phone in Telegram) and resumed at once on the way back ---

/**
 * @typedef {{ code: string, secret: string, check: string, url?: string | null, qr?: string,
 *   expiresIn?: number, deadline: number }} Challenge
 * @typedef {{ polls: () => boolean, tick: (seconds: number) => void, end: (why: 'expired' | 'cancelled') => void,
 *   in: () => void }} Watching
 */
/** @type {{ start: Challenge, on: Watching, interval: number, pollTimer: number, asking: boolean, live: boolean } | null} */
let watcher = null;

const secondsLeft = (start) => Math.max(0, Math.ceil((start.deadline - performance.now()) / 1000));

function unwatch() {
    if (!watcher) return;
    watcher.live = false;
    clearInterval(watcher.interval);
    clearTimeout(watcher.pollTimer);
    watcher = null;
}

/** @param {Challenge} start @param {Watching} on */
function watch(start, on) {
    unwatch();
    const w = { start, on, interval: 0, pollTimer: 0, asking: false, live: true };
    watcher = w;
    if (!document.hidden) run(w, false);
}

/** The countdown now and every second; the poll at once (back from Telegram) or after its pause. */
function run(w, pollNow) {
    clearInterval(w.interval);
    clearTimeout(w.pollTimer);
    if (!tick(w)) return;
    w.interval = window.setInterval(() => tick(w), 1000);
    if (pollNow) ask(w);
    else w.pollTimer = window.setTimeout(() => ask(w), POLL_MS);
}

function pause(w) {
    clearInterval(w.interval);
    clearTimeout(w.pollTimer);
}

/** @returns {boolean} whether the challenge is still alive */
function tick(w) {
    if (!w.live) return false;
    const left = secondsLeft(w.start);
    w.on.tick(left);
    if (watcher !== w) return false;
    if (left) return true;
    unwatch();
    w.on.end('expired');
    return false;
}

async function ask(w) {
    if (!w.live || w.asking || document.hidden) return;
    clearTimeout(w.pollTimer);
    if (!w.on.polls()) {
        w.pollTimer = window.setTimeout(() => ask(w), POLL_MS);
        return;
    }
    w.asking = true;
    let answer;
    try {
        answer = await api('/login/telegram/poll', {
            method: 'POST',
            body: { code: w.start.code, secret: w.start.secret }
        });
    } catch {
        answer = { state: 'waiting' };
    }
    w.asking = false;
    if (answer.state === 'in') {
        if (w.live) {
            unwatch();
            return w.on.in();
        }
        // Answered while another screen took over: the session cookie is set all the same
        if (!$('login-gate').hidden) {
            stopPolling();
            pending = null;
            activeChallenge = null;
            return finish();
        }
        return;
    }
    if (!w.live) return;
    if (answer.state === 'refused' || answer.state === 'gone') {
        unwatch();
        return w.on.end(answer.state === 'refused' ? 'cancelled' : 'expired');
    }
    w.pollTimer = window.setTimeout(() => ask(w), POLL_MS);
}

document.addEventListener('visibilitychange', () => {
    if (!watcher) return;
    if (document.hidden) pause(watcher);
    else run(watcher, true);
});

// --- The challenges themselves ---

// The code for the first screen, asked for when it shows: "Continue with Telegram" is then a plain
// link to the bot, which a phone opens in Telegram without a pop-up or an empty tab left behind
/** @type {Challenge | null} */
let pending = null;
/** @type {Challenge | null} the one a way's screen waits for */
let activeChallenge = null;

function cancelChallenge(start) {
    if (start)
        api('/login/telegram/cancel', { method: 'POST', body: { code: start.code, secret: start.secret } }).catch(
            () => {}
        );
}

function stopPolling() {
    unwatch();
    attempt += 1;
}

function discardChallenges() {
    stopPolling();
    cancelChallenge(pending);
    cancelChallenge(activeChallenge);
    pending = null;
    activeChallenge = null;
}

/** A new code, its deadline on this page's clock (the server's remaining time, not wall clocks). */
async function newChallenge() {
    const start = await api('/login/telegram', { method: 'POST' });
    return { ...start, deadline: performance.now() + (start.expiresIn ?? POLL_FOR_MS) };
}

// --- The ways in ---

// The first screen's code failed: asked again after a while
const RETRY_CODE_MS = 10000;
let retryTimer = 0;

const tile = (action, name, label, waits, cls = '') =>
    `<button type="button" class="login-method${cls ? ` ${cls}` : ''}" data-action="${action}"${waits ? ' disabled' : ''}>${icon(name)}<span>${label}</span></button>`;

/**
 * The ways in. `banner`: why the session ended, over everything; the Telegram button's own failure
 * goes under it (prepareCode).
 */
function signInScreen(banner = '', restoreFocus = $('login-body').contains(document.activeElement)) {
    discardChallenges();
    if (miniApp) return miniAppScreen(banner, restoreFocus);
    gate(
        (banner ? `<div class="login-banner">${loginAlert('login-error', banner)}</div>` : '') +
            '<div class="login-panel login-pick-panel">' +
            '<section class="login-pick" aria-labelledby="login-title">' +
            BRAND +
            '<h2 class="login-heading">Sign in</h2>' +
            // A first time in signs up too: the bot is started on the way (with sign-up open)
            `<a id="login-tg" class="btn btn-primary login-tg"${botTarget()} aria-disabled="true" aria-busy="true" aria-describedby="login-tg-hint" data-action="login-telegram">` +
            `${SPINNER}${icon('send', 'login-tg-send')}<span>Continue with Telegram</span></a>` +
            '<p class="login-lead" id="login-tg-hint">You’ll confirm the sign-in in the NotFckBot chat.</p>' +
            loginAlert('login-tg-error') +
            '<div class="login-or"><h2>Other ways to sign in</h2></div>' +
            '<div class="login-methods">' +
            tile('login-qr', 'qr-code', 'QR code', true) +
            tile('login-code', 'binary', 'Bot code', true) +
            tile('login-password', 'key-round', 'Password', false) +
            '</div></section>' +
            '</div>' +
            TERMS_NOTE,
        'start'
    );
    if (restoreFocus) $('login-title').focus();
    prepareCode();
}

/** The first screen's countdown: a fresh code just before this one ends (its link never lapses). */
function pickTick(left) {
    if (left <= RENEW_AT_S) prepareCode();
}

async function prepareCode() {
    const button = /** @type {HTMLAnchorElement | null} */ (document.getElementById('login-tg'));
    if (!button) return;
    stopPolling();
    clearTimeout(retryTimer);
    const mine = attempt;
    const old = pending;
    pending = null;
    button.removeAttribute('href');
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    for (const t of document.querySelectorAll('[data-action="login-qr"], [data-action="login-code"]'))
        /** @type {HTMLButtonElement} */ (t).disabled = true;
    cancelChallenge(old);
    try {
        const start = await newChallenge();
        // Another screen was drawn or another code asked for meanwhile: this one is for nobody
        if (mine !== attempt || !button.isConnected) return cancelChallenge(start);
        pending = start;
        button.href = botLink(start.url);
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
        for (const t of document.querySelectorAll('[data-action="login-qr"], [data-action="login-code"]'))
            /** @type {HTMLButtonElement} */ (t).disabled = false;
        document.querySelector('.login-pick').classList.remove('has-error');
        setLoginAlert('login-tg-error', '');
        // Nothing to ask about here: the ways' screens poll; this one only keeps the code fresh
        watch(start, {
            polls: () => false,
            tick: pickTick,
            end: () => prepareCode(),
            in: () => {
                pending = null;
                finish();
            }
        });
    } catch (err) {
        if (mine !== attempt || !button.isConnected) return;
        button.removeAttribute('aria-busy');
        document.querySelector('.login-pick').classList.add('has-error');
        setLoginAlert('login-tg-error', `${err.message} A password still works if you have set one.`);
        retryTimer = window.setTimeout(() => {
            if (mine === attempt && button.isConnected) prepareCode();
        }, RETRY_CODE_MS);
    }
}

// --- A way's screen while it waits: Telegram, QR code, Bot code, a password's confirmation ---

/** @typedef {'telegram' | 'qr' | 'code' | 'password'} Mode */

/** The code to send the bot: `/code 482913`, copied with one press. */
const command = (check) =>
    `<div class="login-command" id="login-command"><code>/code ${escapeHtml(check)}</code>` +
    `<button type="button" class="login-copy" data-action="login-copy" aria-label="Copy">${icon('copy')}</button></div>`;

/** The bot's own link without a code (Bot code: the digits sign in, no question in the bot). */
const plainBotLink = (start) => {
    const name = botName(start.url);
    return name ? botLink(`https://t.me/${name}`) : null;
};

const WAIT_TEXT = {
    telegram: 'Waiting for confirmation…',
    qr: '',
    code: 'Waiting for the bot…',
    password: 'Waiting for confirmation…'
};

/** @param {Challenge} start @param {Mode} mode */
function pendingBody(start, mode) {
    const bot = botName(start.url);
    const at = bot ? `@${escapeHtml(bot)}` : 'the bot';
    const left = clock(secondsLeft(start));
    const status = WAIT_TEXT[mode]
        ? `<div class="login-status" id="login-status" role="status" aria-live="polite">${SPINNER}<span>${WAIT_TEXT[mode]} <span id="login-timer" aria-hidden="true">· ${left}</span></span></div>`
        : '<div class="login-status login-status-empty" id="login-status" role="status" aria-live="polite"></div>';
    const digitsBlock = (label, large = false) =>
        `<div class="login-digits${large ? ' login-digits-lg' : ''}" id="login-digits"><span class="login-digits-label">${label}</span>${digits(start.check)}</div>`;
    const link = (cls, text, url, iconName = '') =>
        url
            ? `<a class="${cls}" href="${escapeHtml(url)}"${botTarget()}>${iconName ? icon(iconName) : ''}<span>${text}</span></a>`
            : '';
    if (mode === 'qr')
        return (
            stepHead('Scan the QR code') +
            '<p class="login-lead">Scan with the camera on another device where you’re signed in to Telegram, then confirm in the bot. It shows the same code.</p>' +
            '<div class="login-qr-wrap" id="login-digits">' +
            `<div class="login-qr-box" role="img" aria-label="QR code for signing in"><img src="${escapeHtml(start.qr)}" alt="" /></div>` +
            `<p class="login-qr-meta">The bot will show <span class="login-mono">${escapeHtml(String(start.check).replace(/^(\d{3})(\d{3})$/, '$1 $2'))}</span></p>` +
            `<p class="login-qr-meta" id="login-timer">Code expires in ${left}</p></div>` +
            status +
            '<div class="login-actions" id="login-actions">' +
            `<button type="button" class="btn login-neutral" data-action="login-renew-qr">${icon('refresh-cw')}<span>New code</span></button>` +
            (start.url
                ? `<a class="login-text-btn" data-action="login-here" href="${escapeHtml(botLink(start.url))}"${botTarget()}>Open Telegram on this device</a>`
                : '') +
            ANOTHER_WAY +
            '</div>'
        );
    if (mode === 'code')
        return (
            stepHead('Send the code to the bot') +
            `<p class="login-lead">Open ${at} on any device with Telegram and send this message. Or open Настройки → Вход по коду and send the digits.</p>` +
            digitsBlock('Your code', true) +
            command(start.check) +
            status +
            '<div class="login-actions" id="login-actions">' +
            '<p class="login-safety">Only send a code from your own screen.</p>' +
            link('btn btn-primary', `Open ${at}`, plainBotLink(start), 'send') +
            ANOTHER_WAY +
            '</div>'
        );
    const password = mode === 'password';
    return (
        stepHead('Confirm in Telegram') +
        (password
            ? '<p class="login-lead">We sent a message to your NotFckBot chat. Tap «Да, это я» there to finish signing in.</p>'
            : '<p class="login-lead">We opened the NotFckBot chat. Check that the bot shows the same code and tap «Да, это я». This page will sign you in by itself.</p>') +
        digitsBlock('The bot shows the same code') +
        status +
        (password
            ? ''
            : '<button type="button" class="login-expand" data-action="login-code-help" aria-expanded="false" aria-controls="login-code-help">Sign in with a code</button>' +
              '<div class="login-code-help" id="login-code-help" hidden>' +
              `<p>Send this message to ${at} on any device with Telegram, or open Настройки → Вход по коду and send the digits.</p>` +
              command(start.check) +
              link('login-text-btn', `Open ${at}`, plainBotLink(start)) +
              '</div>') +
        '<div class="login-actions" id="login-actions">' +
        '<p class="login-safety">Only confirm a sign-in you started.</p>' +
        link(
            'btn login-neutral',
            password ? 'Open Telegram' : 'Open Telegram again',
            start.url && botLink(start.url),
            'send'
        ) +
        ANOTHER_WAY +
        '</div>'
    );
}

/** @param {Challenge} start @param {Mode} mode */
function pendingScreen(start, mode) {
    unwatch();
    gate(`<div class="login-panel">${pendingBody(start, mode)}</div>${TERMS_NOTE}`, 'step');
    focusStep();
    watchPending(start, mode);
}

/** @param {Challenge} start @param {Mode} mode */
function watchPending(start, mode) {
    activeChallenge = start;
    watch(start, {
        polls: () => true,
        tick: (left) => {
            const timer = $('login-timer');
            if (timer) timer.textContent = mode === 'qr' ? `Code expires in ${clock(left)}` : `· ${clock(left)}`;
            // The QR renews itself before it ends rather than leaving a dead code up
            if (mode === 'qr' && left <= RENEW_AT_S) renewQr();
        },
        end: (why) => endPending(mode, why),
        in: () => {
            activeChallenge = null;
            finish();
        }
    });
}

/** The QR screen's new code, in place (its own New code, or 5 s before the old one ends). */
async function renewQr() {
    const old = activeChallenge;
    stopPolling();
    const mine = attempt;
    activeChallenge = null;
    cancelChallenge(old);
    const button = /** @type {HTMLButtonElement | null} */ (document.querySelector('[data-action="login-renew-qr"]'));
    if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
    }
    try {
        const start = await newChallenge();
        if (mine !== attempt || !$('login-digits')) return cancelChallenge(start);
        /** @type {HTMLImageElement} */ (document.querySelector('#login-digits img')).src = start.qr;
        document.querySelector('#login-digits .login-mono').textContent = String(start.check).replace(
            /^(\d{3})(\d{3})$/,
            '$1 $2'
        );
        const here = /** @type {HTMLAnchorElement | null} */ (document.querySelector('[data-action="login-here"]'));
        if (here && start.url) here.href = botLink(start.url);
        if (button) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
        watchPending(start, 'qr');
    } catch {
        if (mine === attempt && $('login-digits')) endPending('qr', 'expired');
    }
}

/** The time ran out or the bot said no: the same screen says so and offers a new try. */
function endPending(mode, why) {
    activeChallenge = null;
    const focusWasIn = $('login-body').contains(document.activeElement) && document.activeElement !== $('login-back');
    $('login-digits')?.classList.add('is-ended');
    for (const id of ['login-command', 'login-code-help']) $(id)?.remove();
    document.querySelector('.login-expand')?.remove();
    const text =
        why === 'cancelled'
            ? 'Sign-in was cancelled in the bot.'
            : mode === 'code'
              ? 'The code has expired.'
              : 'The time to confirm has run out.';
    const status = $('login-status');
    status.className = 'login-status is-ended';
    status.innerHTML = `${icon('clock')}<span>${text}</span>`;
    const again =
        why === 'expired' && mode === 'code'
            ? `<button type="button" class="btn btn-primary" data-action="login-again" data-mode="code">${icon('refresh-cw')}<span>New code</span></button>`
            : `<button type="button" class="btn btn-primary" data-action="login-again" data-mode="${mode}">Try again</button>`;
    $('login-actions').innerHTML = again + ANOTHER_WAY;
    if (focusWasIn || document.activeElement === document.body)
        /** @type {HTMLElement} */ ($('login-actions').firstElementChild).focus();
}

// --- The rest: the password form, the Terms, a sign-in link, failures ---

function passwordScreen() {
    discardChallenges();
    gate(
        '<div class="login-panel">' +
            stepHead('Sign in with password') +
            '<p class="login-lead">Works if you’ve set a password in Account settings.</p>' +
            signInForm() +
            '</div>' +
            TERMS_NOTE,
        'step'
    );
    focusStep();
}

/**
 * The Terms of Service: plain text on a nested screen, Back to the ways in. A placeholder until the
 * real terms are written (the user, 06.11)
 */
const TERMS =
    '<div class="login-terms">' +
    '<p>NotFckBot is a personal Telegram bot that tells you when new episodes of your series and new films come out. ' +
    'By signing in to this panel you agree to the terms below.</p>' +
    '<h2>Using the bot</h2>' +
    '<p>The bot and the panel are provided as they are, without any guarantee that a notification arrives on time ' +
    'or at all. Release dates come from TMDB and Kinopoisk and may be wrong or change.</p>' +
    '<h2>Your data</h2>' +
    '<p>The bot keeps your Telegram ID and name, the chats it is in, what you follow and your chat settings. ' +
    'The panel keeps your signed-in devices: their name, country, network, IP address and when they were last active. ' +
    'Nothing is sold or shared with anyone.</p>' +
    '<h2>Links</h2>' +
    '<p>Watch and Kinopoisk links lead to other websites. Their content and rules are their own.</p>' +
    '<h2>Changes</h2>' +
    '<p>These terms may change. The version shown here is the one that applies.</p>' +
    '</div>';

const termsScreen = () => {
    discardChallenges();
    gate(
        `<div class="login-panel"><div class="login-terms-top">${stepHead('Terms of Service')}</div>${TERMS}</div>`,
        'step login-terms-screen'
    );
    focusStep();
};

/** /login/<token>: spent only by the press (a messenger's link preview must not use it up). */
const linkScreen = (error = '') => {
    gate(
        '<div class="login-panel">' +
            BRAND +
            '<div class="login-actions">' +
            (error
                ? loginAlert('login-error', error) +
                  '<button type="button" class="btn btn-primary" data-action="login-link-again">Sign in again</button>'
                : '<button type="button" class="btn btn-primary" data-action="login-link">Sign in</button>' +
                  '<p class="login-hint">A sign-in link from the bot.</p>') +
            '</div></div>' +
            TERMS_NOTE,
        'link'
    );
};

/** A failure with its HTTP status line: the icon, the message, then what can be done. */
const problem = (title, status, actions, alert = false) =>
    '<div class="login-panel">' +
    `<div class="login-problem"${alert ? ' role="alert"' : ''}><span class="login-problem-icon">${icon('circle-alert')}</span>` +
    `<h1 id="login-title" tabindex="-1">${escapeHtml(title)}</h1>` +
    (status ? `<p class="login-code" id="login-code">${escapeHtml(status)}</p>` : '') +
    `</div><div class="login-actions">${actions}</div></div>`;

const STATUS_TEXT = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
};

/** The status line under a failure: "503 · Service Unavailable", or no answer at all. */
const statusLine = (err) =>
    err.status ? [err.status, STATUS_TEXT[err.status]].filter(Boolean).join(' · ') : 'No connection';

const RETRY = `<button type="button" class="btn btn-primary" data-action="login-retry">${icon('refresh-cw')}<span>Try again</span></button>`;

/** /account/me failed with something other than 401. */
const panelDownScreen = (err) =>
    gate(
        problem(
            `The panel isn’t answering: ${err.message}`,
            statusLine(err),
            `<button type="button" class="btn btn-primary" data-action="login-retry">${icon('refresh-cw')}<span>Retry</span></button>`,
            true
        ),
        'fail'
    );

// Inside Telegram's own Mini App window: its bridge, the launch data while it may still sign in, and
// what the sign-in screen offers after a failed try ('retry' with the same data, 'reopen' for new data)
let miniApp = null;

const failedMiniApp = (err) => {
    const retry = !err.status || err.status === 429 || err.status >= 500;
    // 409 comes before the launch data is spent: after signing the other account out it signs in here
    if (!retry && err.status !== 409) miniApp.initData = null;
    miniApp.next = retry ? 'retry' : err.status === 401 ? 'reopen' : err.status === 409 ? 'signout' : null;
};

// The deep link to the bot and the QR code would close this window and lose the confirmation:
// here the panel signs in again with Telegram's launch data, or with a password
function miniAppScreen(error, restoreFocus, status = '') {
    const next = miniApp.next ?? (miniApp.initData ? 'retry' : 'reopen');
    const main =
        next === 'retry'
            ? RETRY
            : next === 'reopen'
              ? '<button type="button" class="btn btn-primary" data-action="miniapp-close">Close the app</button>' +
                '<p class="login-hint">Open it again from the bot: Telegram signs you in.</p>'
              : next === 'signout'
                ? '<button type="button" class="btn btn-primary" data-action="miniapp-signout">Sign out</button>'
                : '';
    gate(
        problem(
            error || 'Couldn’t sign you in through Telegram',
            status,
            main +
                '<div class="login-or login-or-plain"><span>Or</span></div>' +
                `<button type="button" class="btn login-neutral" data-action="login-password">${icon('key-round')}<span>Password</span></button>`,
            Boolean(error)
        ),
        'fail'
    );
    if (restoreFocus) $('login-title').focus();
}

/** @type {string | null} the chat this sign-in opens on (a group link or a Mini App opened from a group) */
let openedChat = null;

/** Whether the last sign-in named a chat to open: the panel then starts on its subscriptions. */
export const launchedInChat = () => openedChat !== null;

/**
 * Shows the panel for this session, or the sign-in screen.
 * @param {string | null} [preferredChat]
 * @param {{ current?: () => boolean, focus?: boolean }} [retry] a retry from the Mini App screen: whether
 *   that screen is still the one shown (a late failure doesn't redraw the password form), and whether
 *   focus was in it before its button was disabled
 * @returns {Promise<'admin' | 'user' | null>}
 */
export async function startSession(preferredChat = null, { current = () => true, focus } = {}) {
    if (location.pathname.startsWith('/login/')) {
        linkScreen();
        return null;
    }
    // Telegram sends its signed launch data in the fragment, whatever launch URL BotFather has. A regular
    // browser can open a link containing someone else's launch data, so only the native Mini App bridge
    // enables auto-login.
    const launch = new URLSearchParams(location.hash.slice(1));
    const launchData = launch.get('tgWebAppData');
    // Only names the device in Account settings ("Telegram, iPhone")
    const platform = /^[a-z_]{1,16}$/.test(launch.get('tgWebAppPlatform') || '')
        ? launch.get('tgWebAppPlatform')
        : null;
    if (launchData) window.history.replaceState(null, '', '/');
    const nativeWindow = /** @type {Window & { TelegramWebviewProxy?: {
        postEvent?: (event: string, data: string) => void
    } }} */ (window);
    const bridge = nativeWindow.TelegramWebviewProxy;
    if (typeof bridge?.postEvent === 'function') {
        if (!miniApp) {
            try {
                bridge.postEvent('web_app_setup_swipe_behavior', '{"allow_vertical_swipe":false}');
            } catch {
                // Sign-in can continue when the bridge rejects the optional swipe setting.
            }
        }
        setupTelegramBack(bridge, launch.get('tgWebAppVersion'));
        miniApp = {
            bridge,
            initData: launchData || miniApp?.initData || null,
            platform: platform || miniApp?.platform || null,
            next: miniApp?.next ?? null,
            chat: miniApp?.chat ?? null,
            title: miniApp?.title ?? null
        };
    }
    const initData = miniApp?.initData;
    let me;
    try {
        if (initData) {
            const body = miniApp.platform ? { initData, platform: miniApp.platform } : { initData };
            const signedIn = await api('/login/miniapp', { method: 'POST', body });
            // Opened from a group: its page first (the chat list still decides whether it may be opened)
            // Kept on miniApp: a retry after a failed /account/me no longer has the launch data
            miniApp.chat = signedIn?.chatId ? String(signedIn.chatId) : null;
            miniApp.title = signedIn?.title || null;
            // Spent: a later sign-in screen here offers to reopen the app for new launch data
            miniApp.initData = null;
            miniApp.next = 'reopen';
        }
        me = await api('/account/me');
        if (!preferredChat && miniApp?.chat) preferredChat = miniApp.chat;
    } catch (err) {
        if (initData) {
            // Also when the sign-in went through and /account/me failed: a 5xx there is retried
            failedMiniApp(err);
            if (!current()) return null;
            discardChallenges();
            const message = err.status ? err.message : "Can't reach the panel. Check the connection.";
            miniAppScreen(message, focus ?? $('login-body').contains(document.activeElement), statusLine(err));
        } else if (err.status === 401) signInScreen();
        else {
            discardChallenges();
            panelDownScreen(err);
        }
        return null;
    } finally {
        if (initData) bridge.postEvent('web_app_ready', '{}');
    }
    started = true;
    openedChat = me.user.system ? null : preferredChat;
    if (miniApp) miniApp.chat = null;
    setMe(me.user);
    setProfile(me.user);
    resetChatChoice();
    if (!me.user.system && setLaunchTitle(preferredChat, miniApp?.title)) {
        window.history.replaceState(null, '', '/#my-subs');
    }
    if (miniApp) miniApp.title = null;
    document.body.classList.toggle('role-user', me.user.role !== 'admin');
    // The system account has a profile, but no Telegram chats.
    document.body.classList.toggle('system-account', Boolean(me.user.system));
    document.body.classList.remove('signed-out');
    $('login-gate').hidden = true;
    syncTelegramBack();
    if (me.user.system) return me.user.role;
    // The chats ask Telegram about each group: they come later, the panel doesn't wait for them
    api('/account/chats')
        .then((answer) => setChats(answer, preferredChat))
        .catch((err) => chatsFailed(err.message));
    return me.user.role;
}

/** Back to the sign-in screen when a request says the session is over (api.js sends the event). */
export function watchSession() {
    window.addEventListener('session-ended', () => {
        if (started && !document.body.classList.contains('signed-out'))
            signInScreen('Your session has ended. Sign in again.');
    });
    let lastActivity = 0;
    let sending = false;
    const activity = async (event) => {
        if (
            !event.isTrusted ||
            document.hidden ||
            document.body.classList.contains('signed-out') ||
            sending ||
            Date.now() - lastActivity < 60000
        )
            return;
        sending = true;
        try {
            await api('/account/activity', { method: 'POST' });
            lastActivity = Date.now();
        } catch {
            /* The API's 401 handler shows the sign-in screen. */
        } finally {
            sending = false;
        }
    };
    document.addEventListener('pointerdown', activity, { passive: true });
    document.addEventListener('keydown', activity);
}

/** @param {(role: string) => void} onSignedIn what the panel does once in (app.js) */
export function sessionActions(onSignedIn) {
    const signedIn = async (chatId = null) => {
        // Signed in another way: the kept launch data must not sign in again (another account → 409)
        if (miniApp) {
            miniApp.initData = null;
            // A later sign-in screen here (the session ended) offers to reopen the app for new launch data
            miniApp.next = null;
            miniApp.chat = null;
        }
        // The section in the address stays: signing in again lands on the tab that was open
        window.history.replaceState(null, '', `/${location.hash}`);
        const role = await startSession(chatId);
        if (role) onSignedIn(role);
    };
    finish = () => signedIn();
    // One try at a time: Telegram's launch data signs in only once. Choosing Password meanwhile
    // (a new attempt) leaves its form alone when this try fails late
    const retryFrom = async (el, before = async () => {}) => {
        const focus = $('login-body').contains(document.activeElement);
        /** @type {HTMLButtonElement} */ (el).disabled = true;
        stopPolling();
        const mine = attempt;
        await before();
        if (mine !== attempt) return;
        const role = await startSession(null, { current: () => mine === attempt, focus });
        if (role) onSignedIn(role);
    };
    const gateEl = $('login-gate');
    // The password form's Sign in waits for both fields
    gateEl.addEventListener('input', (event) => {
        const form = /** @type {HTMLElement} */ (event.target).closest('form[data-login="password"]');
        if (form) syncSignInButton(/** @type {HTMLFormElement} */ (form));
    });
    gateEl.addEventListener('submit', async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.dataset.login !== 'password') return;
        event.preventDefault();
        stopPolling();
        const mine = attempt;
        const result = await submitSignIn(form);
        if (mine !== attempt) {
            if (result?.confirmation) cancelChallenge(result);
            // The session cookie is set (the system account): stay signed in
            else if (result?.success && !$('login-gate').hidden) await signedIn();
            return;
        }
        if (result?.confirmation)
            pendingScreen({ ...result, deadline: performance.now() + (result.expiresIn ?? POLL_FOR_MS) }, 'password');
        else if (result?.success) await signedIn();
    });
    /** A way's screen from the first screen's code (the button, a tile): the same digits */
    const take = (mode) => {
        const start = pending;
        if (!start) return;
        pending = null;
        pendingScreen(start, mode);
    };
    return {
        // The link itself opens the bot; here the page starts waiting for the answer
        'login-telegram': () => take('telegram'),
        'login-qr': () => take('qr'),
        'login-code': () => take('code'),
        // QR's "Open Telegram on this device": the same code, now confirmed on this device
        'login-here': () => {
            if (activeChallenge) pendingScreen(activeChallenge, 'telegram');
        },
        // The QR screen's New code, in place
        'login-renew-qr': () => renewQr(),
        // "Try again" / "New code" on a way's screen: a password asks for the password again
        'login-again': async (el) => {
            const mode = /** @type {Mode} */ (el.dataset.mode);
            if (mode === 'password') return passwordScreen();
            const button = /** @type {HTMLButtonElement} */ (el);
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            const old = activeChallenge;
            stopPolling();
            const mine = attempt;
            activeChallenge = null;
            cancelChallenge(old);
            try {
                const start = await newChallenge();
                if (mine !== attempt) return cancelChallenge(start);
                pendingScreen(start, mode);
            } catch (err) {
                if (mine === attempt) signInScreen(err.message, true);
            }
        },
        'login-code-help': (el) => {
            const help = $('login-code-help');
            const open = help.hidden;
            help.hidden = !open;
            el.setAttribute('aria-expanded', String(open));
        },
        'login-copy': async () => {
            const check = activeChallenge?.check;
            if (!check) return;
            try {
                await navigator.clipboard.writeText(`/code ${check}`);
                toast('Copied', 'success', 2000);
            } catch {
                toast("Couldn't copy. Type the code instead.", 'error');
            }
        },
        'login-terms': () => termsScreen(),
        'login-password': () => passwordScreen(),
        'login-cancel': () => signInScreen('', true),
        'miniapp-close': () => miniApp?.bridge.postEvent('web_app_close', '{}'),
        'login-retry': (el) => retryFrom(el),
        // Another account's session in this window (409): end it, then the kept launch data signs in
        'miniapp-signout': (el) => retryFrom(el, () => api('/logout', { method: 'POST' }).catch(() => {})),
        'login-link': async (el) => {
            const button = /** @type {HTMLButtonElement} */ (el);
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            try {
                const { chatId } = await api('/login', {
                    method: 'POST',
                    body: { token: location.pathname.split('/')[2] || '' }
                });
                await signedIn(chatId);
            } catch (err) {
                linkScreen(err.message);
                /** @type {HTMLElement | null} */ (
                    $('login-body').querySelector('[data-action="login-link-again"]')
                )?.focus();
            }
        },
        'login-link-again': () => {
            window.history.replaceState(null, '', '/');
            signInScreen('', true);
        },
        logout: async () => {
            try {
                await api('/logout', { method: 'POST' });
            } catch {
                // Signed out on this page all the same
            }
            location.href = '/';
        }
    };
}
