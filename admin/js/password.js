/**
 * Signing in with a password (src/account/password.js): the form on the sign-in screen, the
 * "Sign-in" group on the account's Settings page and the dialog that sets, changes or removes the
 * password. It is set after signing in with Telegram, so it always belongs to a Telegram account.
 */
import { api } from './api.js';
import { $, $field, escapeHtml } from './dom.js';
import { openModal, closeModal, showConfirm, toast, focusField } from './ui.js';

const MIN_LENGTH = 8;

const EYE =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>';
const CHEVRON_RIGHT =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>';

/** @type {{ id: string, name: string | null, hasPassword: boolean } | null} */
let me = null;

/** A password field with a show/hide button beside it. */
const passwordField = (id, autocomplete, label) =>
    `<div class="token-row"><input id="${id}" class="input-field" type="password" autocomplete="${autocomplete}" maxlength="128" aria-label="${label}" />` +
    `<button type="button" class="btn btn-outline btn-icon-square" data-action="password-show" data-for="${id}" aria-label="Show password" aria-pressed="false">${EYE}</button></div>`;

/** The form under "Sign in with Telegram" (session.js draws the screen). */
export const signInForm = () =>
    '<p class="login-or">or with a password</p>' +
    '<form class="login-password" data-login="password" novalidate>' +
    '<label class="field-label" for="login-name">Telegram username or ID</label>' +
    '<input id="login-name" class="input-field" name="login" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="@username" maxlength="64" />' +
    '<label class="field-label" for="login-pass">Password</label>' +
    passwordField('login-pass', 'current-password', 'Password') +
    '<p class="login-error" id="login-pass-error" role="alert" hidden></p>' +
    '<button type="submit" class="btn btn-outline btn-block">Sign in</button>' +
    '</form>' +
    '<p class="login-hint">Forgot it? Sign in with Telegram and set a new one in Settings.</p>';

/**
 * Sends the sign-in form.
 * @returns {Promise<boolean>} whether the session started
 */
export async function submitSignIn(form) {
    const error = $('login-pass-error');
    const login = $field('login-name').value.trim();
    const password = $field('login-pass').value;
    const say = (text) => {
        error.textContent = text;
        error.hidden = !text;
    };
    const missing = !login ? 'Enter your Telegram username or ID.' : !password ? 'Enter your password.' : '';
    if (missing) {
        say(missing);
        return false;
    }
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    button.disabled = true;
    say('');
    try {
        await api('/login/password', { method: 'POST', body: { login, password } });
        return true;
    } catch (err) {
        say(err.message);
        $field('login-pass').value = '';
        return false;
    } finally {
        button.disabled = false;
    }
}

// --- The account's "Sign-in" group ---

/** Who is signed in (session.js, from /account/me). */
export function setMe(user) {
    me = { id: String(user.id), name: user.name || null, hasPassword: Boolean(user.hasPassword) };
    renderSignIn();
}

function renderSignIn() {
    const holder = $('my-signin');
    if (!holder || !me) return;
    const who = me.name ? `${me.name} · ${me.id}` : me.id;
    holder.innerHTML =
        '<section class="mine-group"><h3 class="mine-group-title">Sign-in</h3><ul class="glass-card mine-sets">' +
        `<li class="mine-set"><span class="mine-set-text">Telegram</span><span class="mine-set-value">${escapeHtml(who)}</span></li>` +
        '<li><button type="button" class="mine-set mine-set-pick" data-action="password-open" aria-haspopup="dialog">' +
        '<span class="mine-set-text">Password</span>' +
        `<span class="mine-set-value">${me.hasPassword ? 'Set' : 'Not set'}${CHEVRON_RIGHT}</span></button></li>` +
        '</ul><p class="mine-group-note">With a password you can sign in when Telegram isn\'t answering.</p></section>';
}

function openDialog() {
    if (!me) return;
    $('password-title').textContent = me.hasPassword ? 'Change password' : 'Set a password';
    $('password-remove').hidden = !me.hasPassword;
    for (const id of ['password-new', 'password-again']) {
        const field = $field(id);
        field.value = '';
        field.type = 'password';
    }
    for (const button of document.querySelectorAll('#password-modal [data-action="password-show"]')) {
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', 'Show password');
    }
    showError('');
    openModal('password-modal');
    focusField($field('password-new'));
}

function showError(text) {
    const error = $('password-error');
    error.textContent = text;
    error.hidden = !text;
}

async function save(form) {
    const password = $field('password-new').value;
    if (password.length < MIN_LENGTH) return showError(`At least ${MIN_LENGTH} characters.`);
    if (password !== $field('password-again').value) return showError("The passwords don't match.");
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    button.disabled = true;
    try {
        const changed = me.hasPassword;
        await api('/account/password', { method: 'PUT', body: { password } });
        me.hasPassword = true;
        closeModal('password-modal');
        renderSignIn();
        toast(changed ? 'Password changed' : 'Password set', 'success');
    } catch (err) {
        showError(err.message);
    } finally {
        button.disabled = false;
    }
}

function remove() {
    closeModal('password-modal');
    showConfirm({
        title: 'Remove the password?',
        text: 'You will sign in with Telegram only. You can set a new password at any time.',
        confirmLabel: 'Remove',
        onConfirm: async () => {
            try {
                await api('/account/password', { method: 'DELETE' });
                me.hasPassword = false;
                renderSignIn();
                toast('Password removed', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    });
}

/** Click handlers, merged into app.js's delegation */
export const passwordActions = {
    'password-open': () => openDialog(),
    'password-remove': () => remove(),
    'password-show': (el) => {
        const field = $field(el.dataset.for);
        const show = field.type === 'password';
        field.type = show ? 'text' : 'password';
        el.setAttribute('aria-pressed', String(show));
        el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }
};

/** The dialog's form; the sign-in form is session.js's. */
export function setupPassword() {
    $('password-form').addEventListener('submit', (event) => {
        event.preventDefault();
        save(event.target);
    });
}
