const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, openActions } = require('./helpers');
const { mockPanel } = require('./mock-panel');

watchConsole();

test('user actions end with Settings and keep access and blocking inside it', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await expect(page.locator('#chat-actions-modal .action-title')).toHaveText([
        'Add serial or movie', 'Send message', 'Statistics', 'Changes', 'Settings'
    ]);
    await expect(page.locator('#action-test-notify')).toHaveCount(0);
    await page.locator('#action-settings').click();
    await expect(page.locator('#chat-settings-modal #action-access')).toBeVisible();
    await page.locator('.custom-select:has(#chat-settings-menu) .custom-select-trigger').click();
    await page.locator('.custom-select-option', { hasText: /^Off$/ }).click();
    await page.locator('#action-block').click();
    await expect(page.locator('#block-modal')).toBeVisible();
    await page.locator('#block-modal [data-close-return="block-modal"]').click();
    await expect(page.locator('#chat-settings-modal')).toBeVisible();
    await expect(page.locator('#chat-settings-menu')).toHaveValue('off');
    await page.locator('#chat-settings-modal .modal-x').click();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});

test('Run update check sends nothing until confirmed; Cancel and Escape return to Actions', async ({ page }) => {
    await mockPanel(page);
    const sent = [];
    page.on('request', (r) => {
        if (r.url().endsWith('/api/trigger-check') && r.method() === 'POST') sent.push(r.url());
    });
    await openActions(page);
    await page.locator('#trigger-btn').click();
    await expect(page.locator('#confirm-title')).toHaveText('Run update check?');
    expect(sent).toHaveLength(0);
    await page.locator('#modal-cancel-btn').click();
    await expect(page.locator('#actions-modal')).toBeVisible();
    expect(sent).toHaveLength(0);
    await page.locator('#trigger-btn').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#actions-modal')).toBeVisible();
    expect(sent).toHaveLength(0);
    await page.locator('#trigger-btn').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast-success')).toHaveText('Update check triggered');
    expect(sent).toHaveLength(1);
});
