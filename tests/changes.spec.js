const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, isNarrow } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * A chat's change log (changes.js) on the canned API: the panel's dialog (Chats → actions →
 * Changes), a group admin's settings page, and how long it is kept (Settings → Bot).
 */

watchConsole();

async function openChanges(page, chatId) {
    await openSection(page, 'chats');
    await page.locator(`[data-action="chat-actions"][data-id="${chatId}"]`).click();
    await page.locator('#action-changes').click();
    await expect(page.locator('#changes-modal')).toBeVisible();
}

test('the panel: ten rows a page, the arrows, another page size, a search', async ({ page }) => {
    const panel = await mockPanel(page);
    await openChanges(page, -1003);
    const log = page.locator('#changes-root');
    await expect(page.locator('#changes-sub')).toHaveText('Movie Club');
    await expect(log.locator('.changes-row')).toHaveCount(10);
    await expect(log.locator('.pager-info')).toHaveText('1–10 of 23');
    // Who and where from, then what: a settings line as the bot says it, the panel's own as panel
    await expect(log.locator('.changes-line').nth(0)).toHaveText('Subscribed: The Bear');
    await expect(log.locator('.changes-meta').nth(0)).toContainText('@igor');
    await expect(log.locator('.changes-line').nth(1)).toHaveText('Тихие часы: выключены → 23:00–08:00');
    await expect(log.locator('.changes-line').nth(2)).toHaveText('Severance: now whole season');
    await expect(log.locator('.changes-meta').nth(2)).toContainText('Admin · panel');
    await expect(log.locator('.changes-kept')).toHaveText('Kept for 30 days');

    await expect(log.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await log.getByRole('button', { name: 'Next page' }).click();
    await log.getByRole('button', { name: 'Next page' }).click();
    await expect(log.locator('.pager-info')).toHaveText('21–23 of 23');
    await expect(log.locator('.changes-row')).toHaveCount(3);
    await expect(log.getByRole('button', { name: 'Next page' })).toBeDisabled();

    // A bigger page starts from the first
    await log.locator('.custom-select-trigger').click();
    await page.locator('#changes-modal .custom-select-option', { hasText: /^25$/ }).click();
    await expect(log.locator('.changes-row')).toHaveCount(23);
    await expect(log.locator('.pager-info')).toHaveText('1–23 of 23');

    // The search asks the server once typing stops, from the first page
    await log.locator('.changes-search').fill('анна');
    await expect(log.locator('.changes-row')).toHaveCount(9);
    expect(panel.changesAsked.at(-1).query).toBe('page=1&size=25&q=%D0%B0%D0%BD%D0%BD%D0%B0');
    await log.locator('.changes-search').fill('nothing like it');
    await expect(log.locator('.changes-empty')).toHaveText('Nothing found');
});

test('a chat with no changes says so, without a pager', async ({ page }) => {
    await mockPanel(page, { changes: [] });
    await openChanges(page, -1003);
    await expect(page.locator('#changes-root .changes-empty')).toHaveText('No changes');
    await expect(page.locator('#changes-root .changes-pager')).toBeHidden();
});

test("a group's admin sees its log under the settings, in English like the panel; a member doesn't", async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    const open = async () => {
        await page.locator(isNarrow(page) ? '.tab-item[data-section="my-subs"]' : '.nav-item[data-section="my-subs"]').click();
        await page
            .locator(isNarrow(page) ? '.tab-item[data-section="my-settings"]' : '.nav-item[data-section="my-settings"]')
            .click();
        await page.locator('#my-settings-section select[data-mine="chat"]').selectOption('-100');
    };
    await open();
    await expect(page.locator('.mine-note')).toContainText("Only the group's admins");
    await expect(page.locator('#mine-changes')).toHaveCount(0);

    panel.account.chats[1].settings = true;
    await open();
    const log = page.locator('#mine-changes');
    await expect(log.locator('.changes-row')).toHaveCount(10);
    await expect(log.locator('.pager-info')).toHaveText('1–10 of 23');
    await expect(log.locator('.changes-line').nth(0)).toHaveText('Subscribed: The Bear');
    await expect(log.locator('.changes-meta').nth(1)).toContainText('Анна · account');
    await expect(log.locator('.changes-kept')).toHaveText('Kept for 30 days');
});

test('Settings → Bot: how long the log is kept, saved when picked', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'settings');
    await page.locator('[data-action="settings-tab"][data-tab="bot"]').click();
    const card = page.locator('.settings-card', { hasText: 'Chat change log' });
    await expect(card.locator('.custom-select-trigger')).toHaveText(/30 days/);
    await card.locator('.custom-select-trigger').click();
    await page.locator('.custom-select-option', { hasText: '90 days' }).click();
    await expect(page.locator('.toast').last()).toHaveText('Change log period saved.');
    expect(panel.lastSettingsSave).toEqual({ changesKeepDays: 90 });
});
