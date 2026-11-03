const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, profileButton } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// The final logout can race an in-flight authenticated refresh, which correctly receives 401; the
// chats test makes Telegram fail with 503.
watchConsole({ ignore: /status of (401|503)/ });

const adminProfile = (page) => page.locator('.section.active [data-admin-profile] button');

test('every admin section has a profile instead of the rail view picker and sign out', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('.view-switch, .sidebar [data-action="logout"]')).toHaveCount(0);
    for (const section of ['dashboard', 'chats', 'subs', 'watchlist', 'history', 'recap', 'logs', 'settings']) {
        await openSection(page, section);
        const chip = adminProfile(page);
        await expect(chip).toBeVisible();
        const fits = await chip.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth;
        });
        expect(fits).toBe(true);
        await chip.click();
        await expect(page.locator('#profile-modal [data-action="logout"]')).toBeVisible();
        await expect(page.locator('#profile-modal [data-action="view-mine"]')).toBeVisible();
        await expect(page.locator('#profile-modal [data-action="view-admin"]')).toHaveCount(0);
        await page.keyboard.press('Escape');
    }
});

test('admin profile chat selection opens personal pages and returns to the previous admin section', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'logs');
    await adminProfile(page).click();
    await page.locator('#profile-modal .pick-row', { hasText: 'Киноклуб' }).click();
    await expect(page.locator('#my-subs-section')).toBeVisible();
    await expect(page.locator('#my-subs-body .mine-row')).not.toHaveCount(0);
    await profileButton(page, 'my-subs').click();
    await page.locator('#profile-modal [data-action="view-admin"]').click();
    await expect(page.locator('#logs-section')).toBeVisible();
    await adminProfile(page).click();
    await page.locator('#profile-modal [data-section="my-account"]').click();
    await expect(page.locator('#my-account-section')).toBeVisible();
    await page.locator('#my-account-section .mine-back').click();
    await expect(page.locator('#logs-section')).toBeVisible();
});

test('local admin has profile settings, password and devices, without Telegram choices', async ({ page }) => {
    const panel = await mockPanel(page, { system: true });
    await adminProfile(page).click();
    await expect(page.locator('.profile-head')).toContainText('admin');
    await expect(page.locator('.profile-head')).toContainText('Local account');
    await expect(page.locator('#profile-modal .pick-row, #profile-modal [data-action="view-mine"]')).toHaveCount(0);
    await page.locator('#profile-modal [data-section="my-account"]').click();
    await expect(page.locator('#my-account-info')).toContainText('Local account');
    await expect(page.locator('#my-account-info')).not.toContainText('Telegram');
    await page.locator('#my-signin [data-action="access-system-password"]').click();
    await expect(page.locator('#password-modal')).toBeVisible();
    await page.locator('#password-new').fill('system-pass');
    await page.locator('#password-again').fill('system-pass');
    await page.locator('#password-form [type="submit"]').click();
    await expect(page.locator('#password-modal')).toBeHidden();
    expect(panel.systemPasswords).toEqual(['system-pass']);
    await page.locator('[data-action="profile-end-others"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast-success').last()).toContainText('2 other devices');
    await page.reload();
    await expect(page.locator('#my-account-section')).toBeVisible();
    await expect(adminProfile(page)).toBeVisible();
    await page.locator('#my-account-section .mine-back').click();
    await expect(page.locator('#dashboard-section')).toBeVisible();
    await adminProfile(page).click();
    await page.locator('#profile-modal [data-action="logout"]').click();
    await expect(page.locator('#login-gate')).toBeVisible();
    expect(panel.account.sent.some((r) => r.path === '/api/account/chats')).toBe(false);
});

test('the open profile menu draws the chats in when they arrive, from same-size skeleton rows', async ({ page }) => {
    let finish;
    const chatsWait = new Promise((resolve) => {
        finish = resolve;
    });
    await mockPanel(page, { chatsWait });
    await adminProfile(page).click();
    const menu = page.locator('#profile-modal');
    const skeletons = menu.locator('.pick-row.profile-skeleton');
    await expect(skeletons).toHaveCount(2);
    await expect(menu.locator('.profile-skeleton')).toHaveCount(3);
    await expect(menu.locator('[data-action="profile-chat"]')).toHaveCount(0);
    const skeletonHeight = await skeletons.first().evaluate((el) => el.getBoundingClientRect().height);
    finish();
    // No reopening: the chats and Chat settings appear in the menu that is already open
    await expect(menu.locator('[data-action="profile-chat"]').first()).toBeVisible();
    await expect(menu.locator('[data-section="my-settings"]')).toBeVisible();
    await expect(menu.locator('.profile-skeleton')).toHaveCount(0);
    const rowHeight = await menu
        .locator('[data-action="profile-chat"]')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(rowHeight - skeletonHeight)).toBeLessThan(1);
});

test('chats failing while the profile menu is open show a retry that loads them', async ({ page }) => {
    let finish;
    const chatsWait = new Promise((resolve) => {
        finish = resolve;
    });
    const panel = await mockPanel(page, { chatsWait, chatsDown: true });
    await adminProfile(page).click();
    const menu = page.locator('#profile-modal');
    await expect(menu.locator('.profile-skeleton').first()).toBeVisible();
    finish();
    const retry = menu.locator('[data-action="mine-reload"]');
    await expect(retry).toContainText("Couldn't load chats");
    await expect(menu.locator('.profile-skeleton')).toHaveCount(0);
    panel.account.chatsDown = false;
    await retry.click();
    await expect(menu.locator('[data-action="profile-chat"]').first()).toBeVisible();
    await expect(retry).toHaveCount(0);
});
