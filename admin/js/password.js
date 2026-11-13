/**
 * Signing in with a password (src/account/password.js): the form on the sign-in screen, the
 * "Sign-in methods" group on Account settings, the Password sheet (its state, Change, Remove) and the
 * dialog that sets or changes the password. It is set after signing in with Telegram, so it always belongs to a Telegram account.
 */
import { api } from './api.js';
import { $, $field, setText, escapeHtml } from './dom.js';
import { openModal, closeModal, showConfirm, toast, focusField } from './ui.js';

const MIN_LENGTH = 8;

// Keep the eye mounted: replacing its external <use> can flicker while Safari resolves the sprite.
const PASSWORD_EYE =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-eye" /><path class="password-eye-slash" pathLength="1" d="m3 3 18 18" /></svg>';

/** @type {{ id: string, name: string | null, hasPassword: boolean, changedAt: string | null, system: boolean } | null} */
let me = null;

/** Who is signed in, once /account/me answered (access.js uses it for own-role changes). */
export const signedInUser = () => me;

/** A password field with a borderless show/hide button inside its right edge. */
const passwordField = (id, autocomplete, label) =>
    `<div class="password-input"><input id="${id}" class="input-field" type="password" autocomplete="${autocomplete}" maxlength="128" aria-label="${label}" />` +
    `<button type="button" class="password-toggle" data-action="password-show" data-for="${id}" aria-label="Show password" aria-pressed="false">${PASSWORD_EYE}</button></div>`;

/**
 * A sign-in screen's error: the icon and the text on the danger fill (hidden while empty).
 * @param {string} id
 * @param {string} [text]
 */
export const loginAlert = (id, text = '') =>
    `<div class="login-alert" id="${id}" role="alert"${text ? '' : ' hidden'}>` +
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-circle-alert" /></svg>' +
    `<span>${escapeHtml(text)}</span></div>`;

/** Shows (or with '' hides) a loginAlert's text. */
export function setLoginAlert(id, text) {
    const box = $(id);
    if (!box) return;
    box.querySelector('span').textContent = text;
    box.hidden = !text;
}

/** The sign-in form (session.js draws the screen around it); the system account signs in here too. */
export const signInForm = () =>
    '<form class="login-form" data-login="password" novalidate>' +
    '<label class="login-label" for="login-name">Telegram username or ID</label>' +
    '<input id="login-name" class="input-field" name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="@username or ID" maxlength="64" />' +
    '<label class="login-label" for="login-pass">Password</label>' +
    passwordField('login-pass', 'current-password', 'Password') +
    '<p class="login-note">Forgot it? Sign in with Telegram and set a new one in Account settings.</p>' +
    loginAlert('login-pass-error') +
    '<div class="login-actions"><button type="submit" class="btn btn-primary" disabled>' +
    '<svg class="icon login-spin" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-loader-circle" /></svg>' +
    '<span>Sign in</span></button>' +
    '<button type="button" class="login-text-btn" data-action="login-cancel">Use another way</button></div>' +
    '</form>';

/** Sign in waits for both fields, and for the answer to the last press. */
export function syncSignInButton(form) {
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    if (button.getAttribute('aria-busy') === 'true') return;
    button.disabled = !$field('login-name').value.trim() || !$field('login-pass').value;
}

/**
 * Sends the sign-in form.
 * @returns {Promise<any>} the session or pending confirmation, null on error
 */
export async function submitSignIn(form) {
    const login = $field('login-name').value.trim();
    const passwordInput = $field('login-pass');
    const password = passwordInput.value;
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    // Enter with a field empty: Sign in is off, nothing to send
    if (!login || !password || button.getAttribute('aria-busy') === 'true') return null;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setLoginAlert('login-pass-error', '');
    try {
        const result = await api('/login/password', { method: 'POST', body: { login, password } });
        passwordInput.value = '';
        return result;
    } catch (err) {
        setLoginAlert('login-pass-error', err.message);
        passwordInput.value = '';
        if (form.isConnected) passwordInput.focus();
        return null;
    } finally {
        button.removeAttribute('aria-busy');
        if (form.isConnected) syncSignInButton(form);
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

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;

// "3 Nov", or with the year when it isn't this one
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const changedDay = (iso) => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    return (at.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear).format(at);
};

/** "● On" in green, or a quiet "Off": the password's one state signal */
const passwordState = (on) =>
    on
        ? '<span class="row-status"><span class="status-dot" aria-hidden="true"></span>On</span>'
        : '<span class="row-status row-status-off">Off</span>';

/** Account settings → Sign-in methods: Telegram (always connected) and the password, which opens its sheet */
function renderSignIn() {
    const holder = $('my-signin');
    if (!holder || !me) return;
    if (me.system) {
        // The local account's password lives in Settings → Panel access: its dialog, no sheet
        holder.innerHTML =
            '<h2 class="group-title">Sign-in methods</h2><ul class="group-list">' +
            '<li><button type="button" class="group-row" data-action="access-system-password" aria-haspopup="dialog">' +
            `<span class="row-tile">${icon('key-round')}</span>` +
            '<span class="row-text"><span class="row-name">Password</span><span class="row-meta">Signs in the local account</span></span>' +
            `${passwordState(true)}<span class="row-chevron">${icon('chevron-right')}</span></button></li></ul>`;
        return;
    }
    const changed = me.changedAt ? changedDay(me.changedAt) : '';
    const meta = me.hasPassword ? (changed ? `Changed ${changed}` : 'Set') : 'Not set';
    holder.innerHTML =
        '<h2 class="group-title">Sign-in methods</h2><ul class="group-list">' +
        `<li><div class="group-row group-row-static"><span class="row-tile">${icon('send')}</span>` +
        '<span class="row-text"><span class="row-name">Telegram</span></span>' +
        '<span class="row-status"><span class="status-dot" aria-hidden="true"></span>Connected</span></div></li>' +
        `<li><button type="button" class="group-row" data-action="password-open" aria-haspopup="dialog">` +
        `<span class="row-tile">${icon('key-round')}</span>` +
        `<span class="row-text"><span class="row-name">Password</span><span class="row-meta">${meta}</span></span>` +
        `${passwordState(me.hasPassword)}<span class="row-chevron">${icon('chevron-right')}</span></button></li></ul>` +
        '<p class="group-help">A password lets you sign in when Telegram isn’t responding.</p>';
}

// --- The Password sheet: its state, Change, Remove (removal only here, never on the page) ---

// A removal on its way: another press does nothing
let removing = false;

function sheetHtml() {
    const changed = me.changedAt ? changedDay(me.changedAt) : '';
    return (
        `<button type="button" class="sheet-close" data-close="password-sheet" aria-label="Close">${icon('x')}</button>` +
        `<div class="sheet-head"><span class="row-tile row-tile-xl">${icon('key-round')}</span>` +
        '<h2 id="password-sheet-title">Password</h2>' +
        '<p class="sheet-state"><span class="status-dot" aria-hidden="true"></span>' +
        `<span><span class="sheet-state-on">On</span>${changed ? ` · changed ${changed}` : ''}</span></p>` +
        '<p class="sheet-text">Use it to sign in when Telegram isn’t responding.</p></div>' +
        '<p class="sheet-error" id="password-sheet-error" role="alert" hidden></p>' +
        '<button type="button" class="sheet-btn-primary" data-action="password-change">Change password</button>' +
        `<button type="button" class="sheet-btn-danger-soft" data-action="password-remove-own"${removing ? ' disabled aria-busy="true"' : ''}>${removing ? 'Removing…' : 'Remove password'}</button>` +
        '<p class="sheet-note">After removal you can only sign in with Telegram.</p>'
    );
}

/** The row: the sheet when there is a password, else straight to setting one */
function openPasswordRow() {
    if (!me) return;
    if (!me.hasPassword) return openOwn();
    $('password-sheet-body').innerHTML = sheetHtml();
    openModal('password-sheet');
}

function setRemoving(on) {
    removing = on;
    // Change waits too: a form opened now would set a password the removal is about to take away
    const change = /** @type {HTMLButtonElement | null} */ (
        document.querySelector('#password-sheet [data-action="password-change"]')
    );
    if (change) change.disabled = on;
    const button = /** @type {HTMLButtonElement | null} */ (
        document.querySelector('#password-sheet [data-action="password-remove-own"]')
    );
    if (!button) return;
    button.disabled = on;
    button.toggleAttribute('aria-busy', on);
    button.textContent = on ? 'Removing…' : 'Remove password';
}

/**
 * The row is drawn anew after a change: focus that was on it (handed back by the closed dialog) would
 * fall to the page, so it goes to the new Password row while that is on screen.
 */
function refocusRow() {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const row = /** @type {HTMLElement | null} */ (
        document.querySelector('#my-signin .group-row:not(.group-row-static)')
    );
    if (row?.offsetParent) row.focus();
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
            const who = me;
            const changed = me.hasPassword;
            const result = await api('/account/password', { method: 'PUT', body: { password } });
            // Someone else signed in meanwhile: their row isn't this answer's
            if (me !== who) return;
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
        refocusRow();
    } catch (err) {
        showError(err.message);
    } finally {
        button.disabled = false;
    }
}

function removeOwn() {
    if (removing || !me?.hasPassword) return;
    showConfirm({
        title: 'Remove password?',
        text: 'You’ll only be able to sign in with Telegram.',
        confirmLabel: 'Remove',
        cancelLabel: 'Cancel',
        onConfirm: async () => {
            if (removing) return;
            const who = me;
            setRemoving(true);
            const error = $('password-sheet-error');
            if (error) error.hidden = true;
            try {
                await api('/account/password', { method: 'DELETE' });
                setRemoving(false);
                if (me !== who) return;
                me.hasPassword = false;
                me.changedAt = null;
                closeModal('password-sheet');
                renderSignIn();
                refocusRow();
                toast('Password removed', 'success');
            } catch (err) {
                setRemoving(false);
                // The sheet stays open with the reason (a device signed in today may not remove it)
                if (error && /** @type {HTMLDialogElement} */ ($('password-sheet')).open) {
                    error.textContent = err.message;
                    error.hidden = false;
                } else toast(err.message, 'error');
            }
        }
    });
}

/** Click handlers, merged into app.js's delegation */
export const passwordActions = {
    'password-open': () => openPasswordRow(),
    // Change from the sheet: the sheet goes, the form takes its place
    'password-change': async () => {
        await closeModal('password-sheet');
        openOwn();
    },
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
