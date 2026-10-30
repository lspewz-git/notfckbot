const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Sending the year's recap from the panel, on the canned API: the switch in Settings, one chat
 * from its preview, every chat from Users / Chats. Nothing goes out without a second "yes".
 */

watchConsole();

const YEAR = new Date().getFullYear();
async function openPreview(page) {
    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="-1003"]').click();
    await page.locator('#action-stats').click();
    await page.locator('#chat-stats-recap').click();
    await expect(page.locator('#recap-modal')).toBeVisible();
}

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

test('a chat that has its year: when, and "Send again" behind its own question', async ({ page }) => {
    const panel = await mockPanel(page, { recapStatus: { status: 'sent', sentAt: '2026-12-31T07:02:00Z' } });
    await openPreview(page);
    await expect(page.locator('#recap-status')).toContainText('Sent 31 Dec 2026');
    const again = page.locator('[data-action="recap-send-one"][data-again="true"]');
    await expect(again).toHaveText('Send again');

    await again.click();
    await expect(page.locator('#confirm-title')).toHaveText(`Send the ${YEAR} recap again?`);
    await expect(page.locator('#confirm-text')).toContainText('Movie Club already got it on 31 Dec 2026');
    await page.locator('#modal-cancel-btn').click();
    expect(panel.recapSendOne).toBeUndefined();

    await again.click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#recap-actions .btn')).toHaveText('Queued');
    expect(panel.recapSendOne).toEqual({ chatId: '-1003', body: { year: YEAR, again: true } });
});

test('every chat: the counts, a second "yes", then the progress with Stop', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'chats');
    await page.locator('#chats-section [data-action="recap-send-open"]').click();
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

test('Settings: the recap by date only says what is set, and opens Year recap → Schedule', async ({ page }) => {
    // The first chat far ahead: the tab shows it waiting
    await mockPanel(page, {
        recapSchedule: { on: true, day: `${YEAR}-12-28`, hour: 12, firstAt: `${YEAR + 5}-12-28T00:00:00Z` }
    });
    await openSection(page, 'settings');
    await page.locator('[data-action="settings-tab"][data-tab="bot"]').click();
    await expect(page.locator('.settings-title', { hasText: 'Year recap' })).not.toContainText('in dev');
    await expect(page.locator('#settings-recap')).toHaveText(`On · 28 Dec ${YEAR}, 12:00 chat's time`);
    await page.locator('#settings-section [data-tab="schedule"]').click();
    await expect(page.locator('#recap-section')).toHaveClass(/active/);
    await expect(page.locator('#recap-sched-pane')).toBeVisible();
    await expect(page.locator('#recap-sched-state')).toContainText(`On: 28 December ${YEAR}, 12:00 chat's time`);
});

test('Stop with sending by date on, .env not writable: a warning that a restart turns it on again', async ({
    page
}) => {
    await mockPanel(page, {
        recapSchedule: { on: true, day: `${YEAR}-12-28`, hour: 12, firstAt: `${YEAR + 5}-12-28T00:00:00Z` },
        recapStopSaved: false
    });
    await openSection(page, 'chats');
    await page.locator('#chats-section [data-action="recap-send-open"]').click();
    const dialog = page.locator('#recap-send-modal');
    await dialog.locator('[data-action="recap-send-all"]').click();
    await page.locator('#modal-confirm-btn').click();
    await dialog.locator('[data-action="recap-send-stop"]').click();
    await expect(page.locator('.toast', { hasText: 'sending by date turned off' })).toBeVisible();
    await expect(page.locator('.toast', { hasText: "off until a restart: .env couldn't be written" })).toBeVisible();
});
