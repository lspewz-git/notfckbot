const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, openAccount } = require('./helpers');
const { mockPanel } = require('./mock-panel');

watchConsole();

for (const role of ['user', 'admin']) {
    test(`${role}: choosing a chat in Account opens its Calendar, including the current chat`, async ({ page }) => {
        const panel = await mockPanel(page, { role });
        for (const title of ['Киноклуб', 'My account', 'My account']) {
            await openAccount(page);
            await page.locator('#my-profile-body .chat-row', { hasText: title }).click();
            await expect(page.locator('#my-calendar-section')).toBeVisible();
            await expect(page).toHaveURL(/#my-calendar$/);
            await expect(page.locator('body')).toHaveClass(/view-mine/);
            await expect(page.locator('#my-calendar-section .mine-chat-chip')).toContainText(title);
            await expect(page.locator('#my-calendar-body button.cal-row')).toHaveCount(2);
            await expect(page.locator('.tab-item[data-section="my-calendar"]')).toHaveAttribute('aria-current', 'page');
        }
        if (role === 'user') expect(panel.account.sent.every((r) => r.path.startsWith('/api/account/'))).toBe(true);
    });
}

test('account pages keep the admin or personal navigation through nested pages, Back and reload', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'chats');
    for (const view of ['admin', 'mine']) {
        if (view === 'mine') {
            await openAccount(page);
            await page.locator('#my-profile-body .chat-row[aria-pressed="true"]').click();
        }
        await openAccount(page);
        await expect(page.locator('body')).toHaveClass(view === 'mine' ? /view-mine/ : /^(?!.*view-mine)/);
        await page.locator('#my-profile-body .profile-card').click();
        await page.locator('#my-devices [data-action="devices-open"]').click();
        await expect(page.locator('#my-devices-section')).toBeVisible();
        await page.reload();
        await expect(page.locator('#my-devices-section')).toBeVisible();
        await expect(page.locator('body')).toHaveClass(view === 'mine' ? /view-mine/ : /^(?!.*view-mine)/);
        await page.locator('#my-devices-section .page-back').click();
        await page.locator('#my-account-section .page-back').click();
        await page.locator('#my-profile-body [data-section="my-settings"]').click();
        await expect(page.locator('#my-settings-section')).toBeVisible();
        await expect(page.locator('body')).toHaveClass(view === 'mine' ? /view-mine/ : /^(?!.*view-mine)/);
        await page.locator('#my-settings-section .page-back').click();
        await page.locator('#my-profile-body [data-action="view-admin"]').click();
        // Reload starts a new runtime, but shared pages must never become an admin return destination.
        await expect(page.locator('#dashboard-section')).toBeVisible();
    }
});
