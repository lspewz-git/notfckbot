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
    const menu = page.getByRole('switch', { name: 'Bottom menu' });
    await expect(menu).toBeChecked();
    await menu.click();
    await page.locator('#action-block').click();
    await expect(page.locator('#block-modal')).toBeVisible();
    await page.locator('#block-modal [data-close-return="block-modal"]').click();
    await expect(page.locator('#chat-settings-modal')).toBeVisible();
    await expect(menu).not.toBeChecked();
    await page.locator('#chat-settings-modal .modal-back').click();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});

test('the backdrop and close button dismiss the chat action flow', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'chats');
    const opener = page.locator('[data-action="chat-actions"][data-id="101"]');
    const settings = page.locator('#chat-settings-modal');
    const trigger = settings.locator('.custom-select:has(#chat-settings-digest-week) .custom-select-trigger');
    const openSettings = async () => {
        await opener.click();
        await page.locator('#action-settings').click();
    };

    await openSettings();
    await trigger.focus();
    await expect(trigger).toHaveCSS('outline-style', 'none');
    await expect(trigger).toHaveCSS('box-shadow', 'none');
    await trigger.click();
    await expect(trigger).toHaveCSS('box-shadow', 'none');
    await settings.click({ position: { x: 2, y: 2 } });
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.custom-select-panel')).toHaveCount(0);

    await openSettings();
    await page.locator('#action-block').click();
    await page.locator('#block-modal .modal-x').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
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
