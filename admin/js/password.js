/**
 * Signing in with a password (src/account/password.js): the form on the sign-in screen, the
 * "Sign-in" group on the account's Settings page and the dialog that sets, changes or removes the
 * password. It is set after signing in with Telegram, so it always belongs to a Telegram account.
 */
import { api } from './api.js';
import { $, $field, setText } from './dom.js';
import { openModal, closeModal, showConfirm, toast, focusField } from './ui.js';
import { shortDay } from './format.js';

const MIN_LENGTH = 8;

// Keep the eye mounted: replacing its external <use> can flicker while Safari resolves the sprite.
const PASSWORD_EYE =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#eye" /><path class="password-eye-slash" pathLength="1" d="m3 3 18 18" /></svg>';
const CHEVRON_RIGHT =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#chevron-right" /></svg>';

/** @type {{ id: string, name: string | null, hasPassword: boolean, changedAt: string | null, system: boolean } | null} */
let me = null;

/** Who is signed in, once /account/me answered (access.js uses it for own-role changes). */
export const signedInUser = () => me;

/** A password field with a borderless show/hide button inside its right edge. */
const passwordField = (id, autocomplete, label) =>
    `<div class="password-input"><input id="${id}" class="input-field" type="password" autocomplete="${autocomplete}" maxlength="128" aria-label="${label}" />` +
    `<button type="button" class="password-toggle" data-action="password-show" data-for="${id}" aria-label="Show password" aria-pressed="false">${PASSWORD_EYE}</button></div>`;

/** The form under "Continue with Telegram" (session.js draws the screen); the system account signs in here too. */
export const signInForm = () =>
    '<form class="login-password" data-login="password" novalidate>' +
    '<label class="field-label" for="login-name">Login</label>' +
    '<input id="login-name" class="input-field" name="login" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="@username or ID" maxlength="64" />' +
    '<label class="field-label" for="login-pass">Password</label>' +
    passwordField('login-pass', 'current-password', 'Password') +
    '<p class="login-error" id="login-pass-error" role="alert" hidden></p>' +
    '<button type="submit" class="btn btn-primary btn-block">Log In</button>' +
    '</form>' +
    '<p class="login-hint">Next, confirm this sign-in in the bot. The system account signs in directly.</p>';

/**
 * Sends the sign-in form.
 * @returns {Promise<any>} the session or pending confirmation, null on error
 */
export async function submitSignIn(form) {
    const error = $('login-pass-error');
    const login = $field('login-name').value.trim();
    const passwordInput = $field('login-pass');
    const password = passwordInput.value;
    const say = (text) => {
        error.textContent = text;
        error.hidden = !text;
    };
    const missing = !login ? 'Enter your @username or ID.' : !password ? 'Enter your password.' : '';
    if (missing) {
        say(missing);
        return null;
    }
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    button.disabled = true;
    say('');
    try {
        const result = await api('/login/password', { method: 'POST', body: { login, password } });
        passwordInput.value = '';
        return result;
    } catch (err) {
        say(err.message);
        passwordInput.value = '';
        return null;
    } finally {
        button.disabled = false;
    }
}

// --- The account's "Sign-in" group ---

/** Who is signed in (session.js, from /account/me). */
export function setMe(user) {
    me = {
        id: String(user.id),
        name: user.name || null,
        hasPassword: Boolean(user.hasPassword),
        changedAt: user.passwordChangedAt || null,
        system: Boolean(user.system)
    };
    renderSignIn();
}

function renderSignIn() {
    const holder = $('my-signin');
    if (!holder || !me) return;
    if (me.system) {
        holder.innerHTML =
            '<section class="mine-group"><h3 class="mine-group-title">Sign-in</h3><ul class="glass-card mine-sets">' +
            '<li><button type="button" class="mine-set mine-set-pick" data-action="access-system-password" aria-haspopup="dialog">' +
            '<span class="mine-set-text">Password</span>' +
            `<span class="mine-set-value">Change${CHEVRON_RIGHT}</span></button></li></ul></section>`;
        return;
    }
    // Who it is is shown in the Account group above (profile.js). The row says the state in words,
    // its right side the action; removing is a row of its own (issue #16)
    const changed = me.changedAt ? shortDay(me.changedAt) : '';
    const state = me.hasPassword ? `Set${changed ? ` · changed ${changed}` : ''}` : 'Not set: Telegram sign-in only';
    const action = me.hasPassword
        ? '<span class="badge ok">On</span><span class="mine-set-action">Change</span>'
        : '<span class="mine-set-action mine-set-accent">Set up</span>';
    holder.innerHTML =
        '<section class="mine-group"><h3 class="mine-group-title">Sign-in</h3><ul class="glass-card mine-sets">' +
        '<li class="mine-set"><span class="mine-set-text">Telegram</span><span class="mine-set-value">Connected</span></li>' +
        '<li><button type="button" class="mine-set mine-set-pick" data-action="password-open" aria-haspopup="dialog">' +
        `<span class="mine-set-text"><span>Password</span><span class="mine-set-sub">${state}</span></span>` +
        `<span class="mine-set-value">${action}${CHEVRON_RIGHT}</span></button></li>` +
        (me.hasPassword
            ? '<li><button type="button" class="mine-set mine-set-pick mine-set-danger" data-action="password-remove-own" aria-haspopup="dialog">' +
              '<span class="mine-set-text">Remove password</span></button></li>'
            : '') +
        '</ul><p class="mine-group-note">With a password you can sign in when Telegram isn\'t answering.</p></section>';
}

/**
 * The password dialog: the own one from the account page, the system account's from Settings.
 * @type {{ save: (password: string) => Promise<void> } | null}
 */
let dialog = null;

/**
 * @param {{ title: string, sub: string, hint: string, save: (password: string) => Promise<void> }} options
 *   save throws to show its message in the dialog
 */
export function openPasswordDialog({ title, sub, hint, save }) {
    dialog = { save };
    setText('password-title', title);
    setText('password-sub', sub);
    setText('password-hint', hint);
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

function openOwn() {
    if (!me) return;
    openPasswordDialog({
        title: me.hasPassword ? 'Change password' : 'Set a password',
        sub: "For signing in when Telegram isn't answering, with your @username or ID.",
        hint: 'At least 8 characters. A change signs you out on your other devices; the bot tells you about it.',
        save: async (password) => {
            const changed = me.hasPassword;
            const result = await api('/account/password', { method: 'PUT', body: { password } });
            me.hasPassword = true;
            me.changedAt = result.passwordChangedAt || null;
            renderSignIn();
            toast(changed ? 'Password changed' : 'Password set', 'success');
        }
    });
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
        await dialog.save(password);
        closeModal('password-modal');
    } catch (err) {
        showError(err.message);
    } finally {
        button.disabled = false;
    }
}

function removeOwn() {
    showConfirm({
        title: 'Remove the password?',
        text: 'You will sign in with Telegram only. You can set a new password at any time.',
        confirmLabel: 'Remove',
        onConfirm: async () => {
            try {
                await api('/account/password', { method: 'DELETE' });
                me.hasPassword = false;
                me.changedAt = null;
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
    'password-open': () => openOwn(),
    'password-remove-own': () => removeOwn(),
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
    // The same field as the sign-in form's, drawn into the placeholders that hold its id
    $('password-new').outerHTML = passwordField('password-new', 'new-password', 'New password');
    $('password-again').outerHTML = passwordField('password-again', 'new-password', 'Repeat it');
    $('password-form').addEventListener('submit', (event) => {
        event.preventDefault();
        save(event.target);
    });
}
