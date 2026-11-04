/**
 * Who is using the panel (src/account/auth.js). Without a session the sign-in screen covers it:
 * "Continue with Telegram" (the bot asks to confirm, this page waits for the answer), or the link
 * from login-link.js on the server (/login/<token>, spent only by the press of "Sign in"), or a password the user
 * set on their account page (password.js). With one, an admin
 * gets the whole panel and a user (body.role-user) only their own chats.
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { setChats, chatsFailed, resetChatChoice } from './account.js';
import { signInForm, submitSignIn, setMe } from './password.js';
import { setProfile } from './profile.js';

const POLL_MS = 1500;
const POLL_FOR_MS = 5 * 60 * 1000;
const TG_ICON =
    '<svg class="icon login-telegram-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.3 18.4 21c-.2 1-1 1.2-1.8.7l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.3L5.8 14.2.9 12.7c-1-.3-1-1 .2-1.5L20.3 3c.9-.3 1.6.2 1.4.3Z" /></svg>';
const QR_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#qr-code" /></svg>';
const KEY_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#key-round" /></svg>';
const backButton =
    '<button type="button" id="login-back" class="btn btn-ghost login-back" data-action="login-cancel"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#arrow-left" /></svg>All sign-in methods</button>';

let pollTimer = 0;
// Each "Continue with Telegram" press: an older attempt's poll still on its way stops when it lands
let attempt = 0;
// The first check of the session has answered: a 401 before it is that check's own, not an ended session
let started = false;

const gate = (html) => {
    $('login-body').innerHTML = html;
    $('login-gate').hidden = false;
    document.body.classList.add('signed-out');
};

// The code for "Continue with Telegram", asked for when the screen shows: the button is then a plain
// link to the bot, which a phone opens in Telegram without a pop-up or an empty tab left behind
let pending = null;
let activeChallenge = null;

function cancelChallenge(start) {
    if (start)
        api('/login/telegram/cancel', { method: 'POST', body: { code: start.code, secret: start.secret } }).catch(
            () => {}
        );
}

function discardChallenges() {
    stopPolling();
    cancelChallenge(pending);
    cancelChallenge(activeChallenge);
    pending = null;
    activeChallenge = null;
}

async function prepareCode() {
    const button = /** @type {HTMLAnchorElement | null} */ (document.getElementById('login-tg'));
    if (!button) return;
    pending = null;
    try {
        const start = await api('/login/telegram', { method: 'POST' });
        // Another screen was drawn meanwhile (and asked for its own code): this one is for nobody
        if (!button.isConnected) {
            cancelChallenge(start);
            return;
        }
        pending = { ...start, deadline: performance.now() + (start.expiresIn ?? POLL_FOR_MS) };
        button.href = start.url;
        button.removeAttribute('aria-disabled');
        const qr = document.querySelector('[data-action="login-qr"]');
        if (qr) qr.removeAttribute('disabled');
        // An idle sign-in screen must not keep a dead deep link forever.
        pollTimer = window.setTimeout(() => signInScreen(), Math.max(0, pending.deadline - performance.now()));
    } catch (err) {
        if (!button.isConnected) return;
        const error = document.getElementById('login-error');
        error.textContent = `${err.message} A password still works if you have set one.`;
        error.hidden = false;
    }
}

// Inside Telegram's own Mini App window: its bridge, the launch data while it may still sign in, and
// what the sign-in screen offers after a failed try ('retry' with the same data, 'reopen' for new data)
let miniApp = null;

const failedMiniApp = (err) => {
    const retry = !err.status || err.status === 429 || err.status >= 500;
    // 409 comes before the launch data is spent: after signing the other account out it signs in here
    if (!retry && err.status !== 409) miniApp.initData = null;
    miniApp.next = retry ? 'retry' : err.status === 401 ? 'reopen' : err.status === 409 ? 'signout' : null;
};

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

/** The status line under a failed Mini App sign-in: "503 · Service Unavailable", or no answer at all. */
const statusLine = (err) =>
    err.status ? [err.status, STATUS_TEXT[err.status]].filter(Boolean).join(' · ') : 'No connection';

// The deep link to the bot and the QR code would close this window and lose the confirmation:
// here the panel signs in again with Telegram's launch data, or with a password
function miniAppScreen(error, restoreFocus, status = '') {
    const next = miniApp.next ?? (miniApp.initData ? 'retry' : 'reopen');
    gate(
        `<p class="login-error" id="login-error" role="alert"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>` +
            (status ? `<p class="login-code" id="login-code">${escapeHtml(status)}</p>` : '') +
            (next === 'retry'
                ? '<button type="button" class="btn btn-primary btn-block" data-action="login-retry">Try again</button>'
                : next === 'reopen'
                  ? '<button type="button" class="btn btn-primary btn-block" data-action="miniapp-close">Close the app</button>' +
                    '<p class="login-hint">Open it again from the bot: Telegram signs you in.</p>'
                  : next === 'signout'
                    ? '<button type="button" class="btn btn-primary btn-block" data-action="miniapp-signout">Sign out</button>'
                    : '') +
            '<p class="login-or">Or</p>' +
            `<button type="button" class="btn btn-outline btn-block" data-action="login-password">${KEY_ICON}Password</button>`
    );
    if (restoreFocus) $('login-title').focus();
}

function signInScreen(error = '', restoreFocus = $('login-body').contains(document.activeElement)) {
    discardChallenges();
    if (miniApp) return miniAppScreen(error, restoreFocus);
    gate(
        // A first time in signs up too: the bot is started on the way (with sign-up open)
        '<div class="login-primary-method">' +
            `<a id="login-tg" class="btn btn-primary btn-block" target="_blank" rel="noopener noreferrer" aria-disabled="true" aria-describedby="login-tg-hint" data-action="login-telegram">${TG_ICON}Continue with Telegram</a>` +
            '<p class="login-hint" id="login-tg-hint">You’ll confirm the sign-in in the NotFckBot chat.</p></div>' +
            `<p class="login-error" id="login-error" role="alert"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>` +
            '<p class="login-or">Other ways to sign in</p>' +
            `<div class="login-methods"><button type="button" class="login-method" data-action="login-qr" disabled>${QR_ICON}<span>Scan a QR code</span></button>` +
            `<button type="button" class="login-method" data-action="login-password">${KEY_ICON}<span>Password</span></button></div>`
    );
    if (restoreFocus) $('login-title').focus();
    prepareCode();
}

const waitingScreen = (start, qr = false) =>
    gate(
        backButton +
            `<h2>${qr ? 'Scan to sign in' : 'Confirm in Telegram'}</h2>` +
            `<p class="login-text">${qr ? 'Scan with your phone camera, then confirm in the Telegram bot.' : 'Check that the bot shows the same code, then confirm the sign-in.'}</p>` +
            (qr
                ? `<img class="login-qr" src="${escapeHtml(start.qr)}" alt="Scan to open the Telegram bot" width="232" height="232" />`
                : '') +
            `<p class="login-check"><b>${escapeHtml(start.check)}</b><br /><span class="login-hint">The bot shows the same one</span></p>` +
            (start.url
                ? `<a class="btn btn-outline btn-block" href="${escapeHtml(start.url)}" target="_blank" rel="noopener noreferrer">${qr ? 'Open Telegram on this device' : 'Open the bot again'}</a>`
                : '') +
            '<p class="login-hint" id="login-wait">Waiting for the confirmation…</p>' +
            '<p class="login-hint">Only confirm a sign-in you started.</p>'
    );

const linkScreen = () =>
    gate(
        '<p class="login-text">A sign-in link from the bot.</p>' +
            '<button type="button" class="btn btn-primary btn-block" data-action="login-link">Sign in</button>'
    );

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
    const launchData = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData');
    if (launchData) window.history.replaceState(null, '', '/');
    const nativeWindow = /** @type {Window & { TelegramWebviewProxy?: {
        postEvent?: (event: string, data: string) => void
    } }} */ (window);
    const bridge = nativeWindow.TelegramWebviewProxy;
    if (typeof bridge?.postEvent === 'function') {
        // Telegram's swipe-down closes the app; turned off so pull-refresh.js gets the pull
        if (!miniApp) bridge.postEvent('web_app_setup_swipe_behavior', '{"allow_vertical_swipe":false}');
        miniApp = {
            bridge,
            initData: launchData || miniApp?.initData || null,
            next: miniApp?.next ?? null,
            chat: miniApp?.chat ?? null
        };
    }
    const initData = miniApp?.initData;
    let me;
    try {
        if (initData) {
            const launch = await api('/login/miniapp', { method: 'POST', body: { initData } });
            // Opened from a group: its page first (the chat list still decides whether it may be opened)
            // Kept on miniApp: a retry after a failed /account/me no longer has the launch data
            miniApp.chat = launch?.chatId ? String(launch.chatId) : null;
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
        else
            gate(
                `<p class="login-error" role="alert">The panel isn't answering: ${escapeHtml(err.message)}</p>` +
                    '<button type="button" class="btn btn-outline btn-block" data-action="login-retry">Retry</button>'
            );
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
    document.body.classList.toggle('role-user', me.user.role !== 'admin');
    // The system account has a profile, but no Telegram chats.
    document.body.classList.toggle('system-account', Boolean(me.user.system));
    document.body.classList.remove('signed-out');
    $('login-gate').hidden = true;
    if (me.user.system) return me.user.role;
    // The chats ask Telegram about each group: they come later, the panel doesn't wait for them
    api('/account/chats')
        .then((chats) => setChats(chats, preferredChat))
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

function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = 0;
    attempt += 1;
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
    const waitForConfirmation = (start, qr = false) => {
        stopPolling();
        activeChallenge = start;
        const mine = attempt;
        waitingScreen(start, qr);
        $('login-back').focus();
        const until = start.deadline ?? performance.now() + (start.expiresIn ?? POLL_FOR_MS);
        const poll = async () => {
            if (attempt !== mine) return;
            const left = Math.max(0, Math.ceil((until - performance.now()) / 1000));
            const wait = $('login-wait');
            if (wait)
                wait.textContent = `Waiting for confirmation · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
            if (!left) return signInScreen('The time to confirm has run out. Try again.');
            let answer;
            try {
                answer = await api('/login/telegram/poll', {
                    method: 'POST',
                    body: { code: start.code, secret: start.secret }
                });
            } catch {
                answer = { state: 'waiting' };
            }
            if (attempt !== mine) return;
            if (answer.state === 'in') {
                stopPolling();
                activeChallenge = null;
                return signedIn();
            }
            if (answer.state === 'refused') return signInScreen('Sign-in was cancelled in the bot.');
            if (answer.state === 'gone') return signInScreen('The time to confirm has run out. Try again.');
            pollTimer = window.setTimeout(poll, POLL_MS);
        };
        pollTimer = window.setTimeout(poll, POLL_MS);
    };
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
    $('login-gate').addEventListener('submit', async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.dataset.login !== 'password') return;
        event.preventDefault();
        stopPolling();
        const mine = attempt;
        const result = await submitSignIn(form);
        if (mine !== attempt) {
            if (result?.confirmation) cancelChallenge(result);
            return;
        }
        if (result?.confirmation) waitForConfirmation(result);
        else if (result?.success) await signedIn();
    });
    return {
        'login-telegram': () => {
            // The link itself opens the bot; here the page starts waiting for the answer
            const start = pending;
            if (!start) return;
            pending = null;
            waitForConfirmation(start);
        },
        'login-qr': () => {
            const start = pending;
            if (!start) return;
            pending = null;
            waitForConfirmation(start, true);
        },
        'login-password': () => {
            discardChallenges();
            gate(backButton + '<h2>Sign in with a password</h2>' + signInForm());
            $('login-back').focus();
        },
        'login-cancel': () => {
            stopPolling();
            signInScreen('', true);
        },
        'miniapp-close': () => miniApp?.bridge.postEvent('web_app_close', '{}'),
        'login-retry': (el) => retryFrom(el),
        // Another account's session in this window (409): end it, then the kept launch data signs in
        'miniapp-signout': (el) => retryFrom(el, () => api('/logout', { method: 'POST' }).catch(() => {})),
        'login-link': async (el) => {
            const button = /** @type {HTMLButtonElement} */ (el);
            button.disabled = true;
            try {
                const { chatId } = await api('/login', {
                    method: 'POST',
                    body: { token: location.pathname.split('/')[2] || '' }
                });
                await signedIn(chatId);
            } catch (err) {
                window.history.replaceState(null, '', '/');
                signInScreen(err.message);
            }
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
