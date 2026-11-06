const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openProfilePage } = require('./helpers');

watchConsole();

test('My account is stable while chats load, after they load and on reload', async ({ page }) => {
    let finish;
    const chatsWait = new Promise((resolve) => {
        finish = resolve;
    });
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs', chatsWait });
    await expect(page.locator('body')).not.toHaveClass(/signed-out/);
    const labels = page.locator('[data-chat-picker] .mine-chat-chip-name');
    await expect(labels.first()).toHaveText('My account');
    expect(await labels.allTextContents()).not.toContain('@me');
    finish();
    await expect(page.locator('#my-subs-body button.title-row').first()).toBeVisible();
    await expect(labels.first()).toHaveText('My account');
    await page.reload();
    await expect(labels.first()).toHaveText('My account');
    // Visibility lives on the Account tab now: its Hidden chats row
    await openProfilePage(page, 'my-profile');
    await expect(page.locator('#my-profile-body [data-action="profile-visibility"]')).toContainText('Hidden chats');
    expect(panel.account.chats.length).toBeGreaterThan(0);
});
