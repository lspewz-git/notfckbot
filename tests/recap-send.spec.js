const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * Sending the year's recap from the panel, on the canned API: the switch in Settings, one chat
 * from its preview, every chat from Users / Chats. Nothing goes out without a second "yes".
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

const YEAR = new Date().getFullYear();
const narrow = (page) => (page.viewportSize() || { width: 1280 }).width < 1024;

async function openSection(page, section) {
    if (narrow(page) && !['dashboard', 'chats', 'subs', 'watchlist'].includes(section)) {
        await page.locator('.tab-item', { hasText: 'More' }).click();
        await page.locator(`.action-row[data-section="${section}"]`).click();
    } else {
        await page.locator(`${narrow(page) ? '.tab-item' : '.nav-item'}[data-section="${section}"]`).click();
    }
}

async function openPreview(page) {
    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="-1003"]').click();
    await page.locator('#action-stats').click();
    await page.locator('#chat-stats-recap').click();
    await expect(page.locator('#recap-modal')).toBeVisible();
}

test('the schedule switch off (as on a fresh server): both buttons are ready, nothing goes before a yes', async ({
    page
}) => {
    const panel = await mockPanel(page);
    await openPreview(page);
    await expect(page.locator('#recap-status')).toHaveText('Not sent to this chat yet.');
    await expect(page.locator('[data-action="recap-send-one"]')).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.locator('[data-action="recap-send-open"]').click();
    await expect(page.locator('#recap-send-modal .recap-fact b').first()).toHaveText('37');
    await expect(page.locator('[data-action="recap-send-all"]')).toBeEnabled();
    expect(panel.recapSends).toBeUndefined();
    expect(panel.recapSendOne).toBeUndefined();
});

test('one chat: "No" sends nothing; "Send" queues it once, and the footer says so', async ({ page }) => {
    const panel = await mockPanel(page);
    await openPreview(page);
    await expect(page.locator('#recap-status')).toHaveText('Not sent to this chat yet.');

    await page.locator('[data-action="recap-send-one"]').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await expect(page.locator('#confirm-title')).toHaveText(`Send the ${YEAR} recap?`);
    await page.locator('#modal-cancel-btn').click();
    await expect(page.locator('#confirm-modal')).toBeHidden();
    await expect(page.locator('#recap-modal')).toBeVisible();
    // The question's No goes back to the preview, not past it to the statistics
    await expect(page.locator('#chat-stats-modal')).toBeHidden();
    expect(panel.recapSendOne).toBeUndefined();

    await page.locator('[data-action="recap-send-one"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#recap-status')).toHaveText(
        "Queued: goes out shortly, or when the chat's quiet hours end."
    );
    await expect(page.locator('#recap-actions .btn')).toBeDisabled();
    expect(panel.recapSendOne).toEqual({ chatId: '-1003', body: { year: YEAR } });

    // Closing the preview still goes back to the statistics
    await page.locator('#recap-modal .modal-x').click();
    await expect(page.locator('#chat-stats-modal')).toBeVisible();
});

test('a chat that has its year: when, and no button to send it again', async ({ page }) => {
    await mockPanel(page, { recapStatus: { status: 'sent', sentAt: '2026-12-31T07:02:00Z' } });
    await openPreview(page);
    await expect(page.locator('#recap-status')).toContainText('Sent 31 Dec 2026');
    await expect(page.locator('#recap-actions .btn')).toHaveText('Sent');
    await expect(page.locator('#recap-actions .btn')).toBeDisabled();
});

test('every chat: the counts, a second "yes", then the progress with Stop', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'chats');
    await page.locator('[data-action="recap-send-open"]').click();
    const dialog = page.locator('#recap-send-modal');
    await expect(dialog.locator('.recap-fact b')).toHaveText(['37', '3', '5', '2']);
    await expect(dialog.locator('#recap-send-years .btn.active')).toHaveText(String(YEAR));

    await dialog.locator('[data-action="recap-send-all"]').click();
    await expect(page.locator('#confirm-title')).toHaveText(`Send the ${YEAR} recap to 37 chats?`);
    await page.locator('#modal-confirm-btn').click();
    await expect(dialog.locator('.recap-bar')).toBeVisible();
    await expect(dialog.locator('.recap-fact').first()).toContainText('3 of 40');
    expect(panel.recapSends).toEqual([{ year: YEAR }]);

    await dialog.locator('[data-action="recap-send-stop"]').click();
    await expect(page.locator('.toast', { hasText: 'Stopped: 37 chats taken off the queue' })).toBeVisible();
    expect(panel.recapStopped).toBe(true);
});

test('Settings: the schedule switch is marked in development and saves at once, apart from the other fields', async ({
    page
}) => {
    const panel = await mockPanel(page);
    await openSection(page, 'settings');
    await expect(page.locator('.settings-title', { hasText: 'Year recap' })).toContainText('in dev');
    const sw = page.locator('#settings-recap');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(panel.lastSettingsSave).toEqual({ recapSchedule: true });
    await expect(page.locator('#settings-bar')).toHaveAttribute('data-dirty', 'false');
});
