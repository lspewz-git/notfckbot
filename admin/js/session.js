/**
 * Who is using the panel (src/account/auth.js). Without a session the sign-in screen covers it:
 * "Continue with Telegram" (the bot asks to confirm, this page waits for the answer), or the link
 * from /login in the bot (/login/<token>, spent only by the press of "Sign in"), or a password the user
 * set on their account page (password.js). With one, an admin
 * gets the whole panel and a user (body.role-user) only their own chats.
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { setChats, chatsFailed, setOwnerName } from './account.js';
import { signInForm, submitSignIn, setMe } from './password.js';
import { setProfile } from './profile.js';

const POLL_MS = 1500;
const POLL_FOR_MS = 5 * 60 * 1000;
const TG_ICON =
    '<svg class="icon login-telegram-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.3 18.4 21c-.2 1-1 1.2-1.8.7l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.3L5.8 14.2.9 12.7c-1-.3-1-1 .2-1.5L20.3 3c.9-.3 1.6.2 1.4.3Z" /></svg>';
const QR_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM21 12v3M12 3v3M12 12h3M12 18v3" /></svg>';
const KEY_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="9" r="5" /><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3" /></svg>';
const backButton =
    '<button type="button" class="btn btn-ghost login-back" data-action="login-cancel">← All sign-in methods</button>';

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
        error.textContent = `${err.message} Signing in with /login in the bot still works.`;
        error.hidden = false;
    }
}

function signInScreen(error = '') {
    discardChallenges();
    gate(
        // A first time in signs up too: the bot is started on the way (with sign-up open)
        `<a id="login-tg" class="btn btn-primary btn-block" target="_blank" rel="noopener noreferrer" aria-disabled="true" data-action="login-telegram">${TG_ICON}Continue with Telegram</a>` +
            `<p class="login-error" id="login-error" role="alert"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>` +
            '<p class="login-or">or sign in with</p>' +
            `<div class="login-methods"><button type="button" class="login-method" data-action="login-qr" disabled>${QR_ICON}<span>QR code</span></button>` +
            `<button type="button" class="login-method" data-action="login-password">${KEY_ICON}<span>Password</span></button></div>` +
            '<p class="login-hint">New sign-ins are confirmed in the bot.</p>'
    );
    prepareCode();
}

const waitingScreen = (start, qr = false) =>
    gate(
        backButton +
            `<h2>${qr ? 'Scan to sign in' : 'Confirm in Telegram'}</h2>` +
            `<p class="login-text">${qr ? 'Scan with your phone camera, then confirm in the Telegram bot.' : 'Check that the bot shows the same code, then tap “Да, это я”.'}</p>` +
            (qr
                ? `<img class="login-qr" src="${escapeHtml(start.qr)}" alt="Scan to open the Telegram bot" width="232" height="232" />`
                : '') +
            `<p class="login-check"><b>${escapeHtml(start.check)}</b><br /><span class="login-hint">The bot shows the same one</span></p>` +
            (start.url
                ? `<a class="btn btn-outline btn-block" href="${escapeHtml(start.url)}" target="_blank" rel="noopener noreferrer">Open the bot again</a>`
                : '') +
            '<p class="login-hint" id="login-wait">Waiting for the confirmation…</p>' +
            '<p class="login-hint">Only confirm a sign-in you started.</p>'
    );

const linkScreen = () =>
    gate(
        '<p class="login-text">A sign-in link from the bot.</p>' +
            '<button type="button" class="btn btn-primary btn-block" data-action="login-link">Sign in</button>'
    );

/**
 * Shows the panel for this session, or the sign-in screen.
 * @returns {Promise<'admin' | 'user' | null>}
 */
export async function startSession(preferredChat = null) {
    if (location.pathname.startsWith('/login/')) {
        linkScreen();
        return null;
    }
    let me;
    try {
        me = await api('/account/me');
    } catch (err) {
        if (err.status === 401) signInScreen();
        else
            gate(
                `<p class="login-error" role="alert">The panel isn't answering: ${escapeHtml(err.message)}</p>` +
                    '<button type="button" class="btn btn-outline btn-block" data-action="login-retry">Retry</button>'
            );
        return null;
    }
    started = true;
    setMe(me.user);
    setProfile(me.user);
    setOwnerName(me.user.name || me.user.id);
    document.body.classList.toggle('role-user', me.user.role !== 'admin');
    // The system account is nobody in Telegram: no "My account"
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
        },
        'login-cancel': () => {
            stopPolling();
            signInScreen();
        },
        'login-retry': async () => {
            const role = await startSession();
            if (role) onSignedIn(role);
        },
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
