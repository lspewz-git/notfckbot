const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * A chat's bot settings from the panel (Chats → actions → Settings), on the canned API: who
 * may press the bot's buttons (groups only) and the bottom menu.
 */

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.__errors = errors;
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'console should stay clean').toEqual([]);
});

async function openSettings(page, chatId) {
    const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
    await page.locator(`${narrow ? '.tab-item' : '.nav-item'}[data-section="chats"]`).click();
    await page.locator(`[data-action="chat-actions"][data-id="${chatId}"]`).click();
    await page.locator('#action-settings').click();
    await expect(page.locator('#chat-settings-modal')).toBeVisible();
}

async function pick(page, selectId, text) {
    await page.locator(`.custom-select:has(#${selectId}) .custom-select-trigger`).click();
    await page.locator('.custom-select-option', { hasText: text }).click();
}

test('a group: choose who presses the buttons and the menu, then save', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page, -1003);
    await expect(page.locator('#chat-settings-sub')).toHaveText('Movie Club');
    await expect(page.locator('#chat-settings-buttons-field')).toBeVisible();
    await expect(page.locator('.custom-select:has(#chat-settings-buttons) .custom-select-trigger')).toHaveText(
        'Only whoever called them up'
    );

    await pick(page, 'chat-settings-buttons', 'Everyone in the chat');
    await pick(page, 'chat-settings-menu', 'Off');
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('.toast', { hasText: 'Settings saved' })).toBeVisible();
    await expect(page.locator('#chat-settings-modal')).toBeHidden();
    expect(panel.lastSettings).toEqual({ chatId: '-1003', body: { menu_enabled: false, buttons_mode: 'all' } });
});

test('a private chat has no "who presses" choice: only the menu is sent', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page, 101);
    await expect(page.locator('#chat-settings-buttons-field')).toBeHidden();
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('.toast', { hasText: 'Settings saved' })).toBeVisible();
    expect(panel.lastSettings).toEqual({ chatId: '101', body: { menu_enabled: true } });
});

test('× goes back to the chat menu', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page, 101);
    await page.locator('#chat-settings-modal .modal-x').click();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});
