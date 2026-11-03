const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * A chat's bot settings from the panel (Chats → actions → Settings), on the canned API: who
 * may press the bot's buttons (groups only) and the bottom menu.
 */

watchConsole();

async function openSettings(page, chatId) {
    await openSection(page, 'chats');
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
    await page.getByRole('switch', { name: 'Bottom menu' }).click();
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('.toast', { hasText: 'Settings saved' })).toBeVisible();
    await expect(page.locator('#chat-settings-modal')).toBeHidden();
    expect(panel.lastSettings).toEqual({
        chatId: '-1003',
        body: {
            menu_enabled: false,
            buttons_mode: 'all',
            quiet_start: null,
            quiet_end: null,
            timezone: 'Europe/Moscow',
            digest_week: false,
            digest_month: false
        }
    });
});

test('a private chat has no "who presses" choice: only the menu is sent', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page, 101);
    await expect(page.locator('#chat-settings-buttons-field')).toBeHidden();
    await page.getByRole('switch', { name: 'Bottom menu' }).click();
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('.toast', { hasText: 'Settings saved' })).toBeVisible();
    expect(panel.lastSettings).toEqual({
        chatId: '101',
        body: {
            menu_enabled: false,
            quiet_start: null,
            quiet_end: null,
            timezone: 'Europe/Moscow',
            digest_week: false,
            digest_month: false
        }
    });
});

test('Back returns to the chat menu', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page, 101);
    await page.locator('#chat-settings-modal .modal-back').click();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});

test('quiet hours: from, to and the time zone go with Save; Off sends none', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page, 101);
    const toggle = page.getByRole('switch', { name: 'Quiet hours' });
    const lists = page.locator('#chat-settings-quiet-fields .custom-select-trigger');
    await expect(toggle).not.toBeChecked();
    await expect(lists).toHaveCount(3);
    for (const list of await lists.all()) {
        await expect(list).toBeHidden();
        await expect(list).toBeDisabled();
    }

    await expect(page.locator('#chat-settings-save')).toBeDisabled();
    await page.getByRole('switch', { name: 'Bottom menu' }).click();
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('#chat-settings-modal')).toBeHidden();
    expect(panel.lastSettings.body).toMatchObject({ quiet_start: null, quiet_end: null });

    await openSettings(page, 101);
    await toggle.click();
    const save = page.locator('#chat-settings-save');
    const [buttonBox, dialogBox] = await Promise.all([
        save.boundingBox(),
        page.locator('#chat-settings-modal .modal-content').boundingBox()
    ]);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height);
    await pick(page, 'chat-settings-quiet-start', '23:00');
    await pick(page, 'chat-settings-quiet-end', '08:00');
    await pick(page, 'chat-settings-timezone', 'Vladivostok');
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('#chat-settings-modal')).toBeHidden();
    expect(panel.lastSettings.body).toMatchObject({ quiet_start: 23, quiet_end: 8, timezone: 'Asia/Vladivostok' });
});

test('quiet hours with the same start and end are not sent', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page, 101);
    await page.getByRole('switch', { name: 'Quiet hours' }).click();
    await pick(page, 'chat-settings-quiet-start', '08:00');
    await pick(page, 'chat-settings-quiet-end', '08:00');
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('.toast', { hasText: 'different start and end' })).toBeVisible();
    expect(panel.lastSettings).toBeUndefined();
});

test('digests: weekly and monthly go with Save', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page, 101);
    await page.locator('#chat-settings-digest-week').click();
    await page.locator('#chat-settings-digest-month').click();
    await page.locator('#chat-settings-save').click();
    await expect(page.locator('.toast', { hasText: 'Settings saved' })).toBeVisible();
    expect(panel.lastSettings.body).toMatchObject({ digest_week: true, digest_month: true });
});
