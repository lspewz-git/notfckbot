/**
 * Who is using the panel (src/account/auth.js). Without a session the sign-in screen covers it:
 * "Sign in with Telegram" (the bot asks to confirm, this page waits for the answer), or the link
 * from /login in the bot (/login/<token>, spent only by the press of "Sign in"), or a password the user
 * set on their account page (password.js). With one, an admin
 * gets the whole panel and a user (body.role-user) only their own chats.
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { setChats, chatsFailed } from './account.js';
import { signInForm, submitSignIn, setMe } from './password.js';

const POLL_MS = 1500;
const POLL_FOR_MS = 5 * 60 * 1000;

let pollTimer = 0;
// Each "Sign in with Telegram" press: an older attempt's poll still on its way stops when it lands
let attempt = 0;
// The first check of the session has answered: a 401 before it is that check's own, not an ended session
let started = false;

const gate = (html) => {
    $('login-body').innerHTML = html;
    $('login-gate').hidden = false;
    document.body.classList.add('signed-out');
};

// The code for "Sign in with Telegram", asked for when the screen shows: the button is then a plain
// link to the bot, which a phone opens in Telegram without a pop-up or an empty tab left behind
let pending = null;

async function prepareCode() {
    const button = /** @type {HTMLAnchorElement | null} */ (document.getElementById('login-tg'));
    if (!button) return;
    pending = null;
    try {
        const start = await api('/login/telegram', { method: 'POST' });
        // Another screen was drawn meanwhile (and asked for its own code): this one is for nobody
        if (!button.isConnected) return;
        pending = start;
        button.href = start.url;
        button.removeAttribute('aria-disabled');
    } catch (err) {
        if (!button.isConnected) return;
        const error = document.getElementById('login-error');
        error.textContent = `${err.message} Signing in with /login in the bot still works.`;
        error.hidden = false;
    }
}

function signInScreen(error = '') {
    gate(
        '<p class="login-text">Sign in with Telegram: the bot asks whether it is you.</p>' +
            '<a id="login-tg" class="btn btn-primary btn-block" target="_blank" rel="noopener noreferrer" aria-disabled="true" data-action="login-telegram">Sign in with Telegram</a>' +
            '<p class="login-hint">Or send <b>/login</b> to the bot: it sends a sign-in link.</p>' +
            `<p class="login-error" id="login-error" role="alert"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>` +
            signInForm()
    );
    prepareCode();
}

const waitingScreen = (url, check) =>
    gate(
        '<p class="login-text">In Telegram, start the bot and confirm it is you. This page signs in by itself.</p>' +
            `<p class="login-check">Check code: <b>${escapeHtml(check)}</b><br /><span class="login-hint">The bot shows the same one</span></p>` +
            `<a class="btn btn-outline btn-block" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open the bot again</a>` +
            '<p class="login-hint" id="login-wait">Waiting for the confirmation…</p>' +
            '<button type="button" class="btn btn-ghost btn-block" data-action="login-cancel">Cancel</button>'
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
    document.body.classList.toggle('role-user', me.user.role !== 'admin');
    document.body.classList.remove('signed-out');
    $('login-gate').hidden = true;
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
    $('login-gate').addEventListener('submit', async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.dataset.login !== 'password') return;
        event.preventDefault();
        stopPolling();
        if (await submitSignIn(form)) await signedIn();
    });
    return {
        'login-telegram': () => {
            // The link itself opens the bot; here the page starts waiting for the answer
            const start = pending;
            if (!start) return;
            pending = null;
            stopPolling();
            const mine = attempt;
            waitingScreen(start.url, start.check);
            const until = Date.now() + POLL_FOR_MS;
            const poll = async () => {
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
                    return signedIn();
                }
                if (answer.state === 'refused') {
                    stopPolling();
                    return signInScreen('Sign-in was cancelled in the bot.');
                }
                if (answer.state === 'gone' || Date.now() > until) {
                    stopPolling();
                    return signInScreen('The time to confirm has run out. Try again.');
                }
                pollTimer = window.setTimeout(poll, POLL_MS);
            };
            pollTimer = window.setTimeout(poll, POLL_MS);
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
