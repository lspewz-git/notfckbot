const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, openSettingsTab } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Panel access on the canned API: a person's role in Users (the badge, the Admins tab, the role in
 * the row's menu), and in Settings → Bot the sign-up switch and the system account's password.
 */

// A refused save is a 4xx the browser reports itself
watchConsole({ ignore: /status of 4\d\d/ });

async function pick(page, select, text) {
    await page.locator(`.custom-select:has(${select}) .custom-select-trigger`).click();
    await page.locator('.custom-select-panel .custom-select-option', { hasText: text }).first().click();
}

const chat = (id, username, type, panelRole, extra = {}) => ({
    id,
    username,
    type,
    panelRole,
    blockedUntil: null,
    bot_status: 'active',
    last_seen_at: null,
    ...extra
});

// 42 is the person signed in (tests/mock-account.js)
const CHATS = [
    chat(42, '@me', 'private', 'admin'),
    chat(101, '@alice', 'private', 'admin'),
    chat(102, '@bob', 'private', 'user', { hasPassword: true }),
    chat(103, '@spam', 'private', 'none'),
    chat(104, '@new', 'private', null),
    chat(-1003, 'Movie Club', 'supergroup', null)
];

const openMenu = (page, id) => page.locator(`[data-action="chat-actions"][data-id="${id}"]`).click();

test('Users: a role next to the name; the Admins tab lists the admins', async ({ page }) => {
    await mockPanel(page, { chats: CHATS });
    await openSection(page, 'chats');
    const badges = page.locator('#chats-body .access-badge:visible');
    // The phone shows the name in the row's compact card, the desktop in its column: one badge a row
    await expect(badges).toHaveText(['Admin', 'Admin', 'User', 'No access']);
    await page.locator('.tab-filters [data-chats-tab="admins"]').click();
    await expect(page.locator('#chats-body tr:visible')).toHaveCount(2);
    await expect(page.locator('#chats-body')).toContainText('@alice');
    await expect(page.locator('#chats-body')).not.toContainText('@bob');
});

test('on a phone the four Users tabs stay inside the card: the track scrolls, the page does not', async ({
    page,
    isMobile
}) => {
    test.skip(!isMobile, 'phone layout');
    await mockPanel(page, { chats: CHATS });
    await openSection(page, 'chats');
    await expect(page.locator('#chats-body .access-badge.error:visible')).toHaveText('No access');
    const box = await page.evaluate(() => {
        const track = document.querySelector('#chats-section .tab-filters');
        const card = track.parentElement.getBoundingClientRect();
        const t = track.getBoundingClientRect();
        return {
            inside: t.left >= card.left - 1 && t.right <= card.right + 1,
            scrolls: track.scrollWidth > track.clientWidth,
            pageWide: document.documentElement.scrollWidth > innerWidth
        };
    });
    expect(box).toEqual({ inside: true, scrolls: true, pageWide: false });
    // The last tab is reached by scrolling the track
    await page.locator('.tab-filters [data-chats-tab="left"]').click();
    await expect(page.locator('.tab-filters [data-chats-tab="left"]')).toHaveClass(/active/);
});

test("the row's menu: the role is picked from a dropdown and saved at once; not for groups or yourself", async ({
    page
}) => {
    const panel = await mockPanel(page, { chats: CHATS });
    await openSection(page, 'chats');

    // A group can't sign in
    await openMenu(page, -1003);
    await expect(page.locator('#action-access')).toBeHidden();
    await page.locator('[data-close="chat-actions-modal"].modal-x').click();

    // Your own role can't be changed
    await openMenu(page, 42);
    await expect(page.locator('#action-access .custom-select')).toBeHidden();
    await expect(page.locator('#action-access-desc')).toHaveText("Admin · yours, can't be changed here");
    await page.locator('[data-close="chat-actions-modal"].modal-x').click();

    // Without a role (sign-up closed) the dropdown says No access
    await openMenu(page, 104);
    await expect(page.locator('#action-access-role')).toHaveValue('none');
    await pick(page, '#action-access-role', 'User');
    await expect(page.locator('.toast-success')).toHaveText('@new is User now.');
    expect(panel.accessSaves).toEqual([{ userId: '104', role: 'user' }]);
    // The dialog stays open on the new role, and the row's badge follows
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
    await expect(page.locator('#action-access-role')).toHaveValue('user');
    await page.locator('[data-close="chat-actions-modal"].modal-x').click();
    await expect(
        page.locator('#chats-body tr:visible', { hasText: '@new' }).locator('.access-badge:visible')
    ).toHaveText('User');
});

test('a refused role change says why and shows the saved role again', async ({ page }) => {
    await mockPanel(page, {
        chats: CHATS,
        accessSave: () => ({ status: 403, body: { error: 'Only for the panel admins' } })
    });
    await openSection(page, 'chats');
    await openMenu(page, 102);
    await pick(page, '#action-access-role', 'Admin');
    await expect(page.locator('.toast-error')).toHaveText('Only for the panel admins');
    await expect(page.locator('#action-access-role')).toHaveValue('user');
});

test("someone's password: a row in their menu removes it after a confirmation", async ({ page }) => {
    const panel = await mockPanel(page, { chats: CHATS });
    await openSection(page, 'chats');
    await openMenu(page, 101);
    await expect(page.locator('#action-password-remove')).toBeHidden();
    await page.locator('[data-close="chat-actions-modal"].modal-x').click();

    await openMenu(page, 102);
    await page.locator('#action-password-remove').click();
    await expect(page.locator('#confirm-title')).toHaveText('Remove the password?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast-success')).toHaveText('@bob has no password now.');
    expect(panel.passwordRemoved).toEqual(['102']);
    await openMenu(page, 102);
    await expect(page.locator('#action-password-remove')).toBeHidden();
});

test('Settings: sign-up is switched at once; the system account password is set in a dialog', async ({ page }) => {
    const panel = await mockPanel(page, {
        access: { openSignup: false, system: { login: 'admin', passwordSet: false } }
    });
    await openSection(page, 'settings');
    await openSettingsTab(page, 'bot');
    const signup = page.locator('#access-signup');
    await expect(signup).toHaveAttribute('aria-checked', 'false');
    await signup.click();
    await expect(signup).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.toast-success')).toHaveText('Anyone who starts the bot can sign in now.');

    await expect(page.locator('#access-system-state')).toHaveText("No password: it can't sign in");
    await page.locator('#access-system-password').click();
    await expect(page.locator('#password-title')).toHaveText('Password for "admin"');
    await expect(page.locator('#password-remove')).toBeHidden();
    await page.locator('#password-new').fill('system-pass');
    await page.locator('#password-again').fill('system-pass');
    await page.locator('#password-form [type="submit"]').click();
    await expect(page.locator('#password-modal')).toBeHidden();
    await expect(page.locator('.toast-success').last()).toHaveText('System account password saved');
    expect(panel.systemPasswords).toEqual(['system-pass']);
    await expect(page.locator('#access-system-state')).toHaveText('Password set');
    await expect(page.locator('#access-system-password')).toHaveText('Change password');
});

test('the system account has no "My account": no view switch, no Sign-in group', async ({ page, isMobile }) => {
    const panel = await mockPanel(page, { system: true });
    await expect(page.locator('#login-gate')).toBeHidden();
    if (!isMobile) await expect(page.locator('.view-switch')).toBeHidden();
    else {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await expect(page.locator('#more-modal .action-row[data-section="my-subs"]')).toBeHidden();
    }
    expect(panel.account.sent.some((r) => r.path === '/api/account/chats')).toBe(false);
});

test('the system account opened on an address naming "My account" lands on the dashboard', async ({ page }) => {
    await mockPanel(page, { system: true, path: '/#my-subs' });
    await expect(page.locator('#dashboard-section')).toBeVisible();
    await expect(page.locator('#my-subs-section')).toBeHidden();
});
