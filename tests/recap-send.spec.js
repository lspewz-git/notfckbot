const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Sending the year's recap from Tools, on the canned API. Nothing goes out without confirmation.
 */

watchConsole();

const YEAR = new Date().getFullYear();
async function openPreview(page) {
    await openSection(page, 'recap');
    await page.locator('[data-action="recap-view"][data-chat="-1003"]').click();
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
    // The question's No goes back to the preview.
    await expect(page.locator('#chat-stats-modal')).toBeHidden();
    expect(panel.recapSendOne).toBeUndefined();

    await page.locator('[data-action="recap-send-one"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#recap-status')).toHaveText(
        "Queued: goes out shortly, or when the chat's quiet hours end."
    );
    await expect(page.locator('#recap-actions .btn')).toBeDisabled();
    expect(panel.recapSendOne).toEqual({ chatId: '-1003', body: { year: YEAR } });

    // Closing the preview returns to Ready cards.
    await page.locator('#recap-modal .modal-x').click();
    await expect(page.locator('#recap-modal')).toBeHidden();
    await expect(page.locator('#recap-ready-pane')).toBeVisible();
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
    await openSection(page, 'recap');
    await page.locator('#recap-section [data-action="recap-send-open"]').click();
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

test('Send now keeps the selected recap year, including the schedule year', async ({ page }) => {
    await mockPanel(page, { recapSchedule: { year: YEAR - 1 } });
    await openSection(page, 'recap');
    await page.locator(`#recap-years [data-year="${YEAR - 1}"]`).click();
    await page.locator('#recap-section [data-action="recap-send-open"]').click();
    await expect(page.locator('#recap-send-years .btn.active')).toHaveText(String(YEAR - 1));
    await page.locator('#recap-send-modal .modal-x').click();
    await page.locator(`#recap-years [data-year="${YEAR}"]`).click();
    await page.locator('#recap-section [data-tab="schedule"]').click();
    await expect(page.locator('#recap-sched-pane')).toHaveAttribute('aria-busy', 'false');
    await page.locator('#recap-section [data-action="recap-send-open"]').click();
    await expect(page.locator('#recap-send-years .btn.active')).toHaveText(String(YEAR - 1));
});

test('Send now waits for a current schedule year while loading or saving', async ({ page }) => {
    let releaseLoad, releaseSave;
    const recapScheduleWait = new Promise((resolve) => { releaseLoad = resolve; });
    const recapScheduleSaveWait = new Promise((resolve) => { releaseSave = resolve; });
    await mockPanel(page, { recapScheduleWait, recapScheduleSaveWait });
    await openSection(page, 'recap');
    await page.locator(`#recap-years [data-year="${YEAR - 1}"]`).click();
    await page.locator('#recap-section [data-tab="schedule"]').click();
    const send = page.locator('#recap-section [data-action="recap-send-open"]');
    await expect(send).toBeDisabled();
    releaseLoad();
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.locator('#recap-send-years .btn.active')).toHaveText(String(YEAR));
    await page.locator('#recap-send-modal .modal-x').click();
    await page.locator('#recap-sched-pane .custom-select-trigger').nth(1).click();
    await page.locator('.custom-select-option', { hasText: '18:00' }).click();
    await expect(send).toBeDisabled();
    releaseSave();
    await expect(send).toBeEnabled();
});

test('Settings has no shortcut into year recap', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'settings');
    await page.locator('[data-action="settings-tab"][data-tab="bot"]').click();
    await expect(page.locator('#settings-section [data-section="recap"]')).toHaveCount(0);
});

test('Stop with sending by date on, .env not writable: a warning that a restart turns it on again', async ({
    page
}) => {
    await mockPanel(page, {
        recapSchedule: { on: true, day: `${YEAR}-12-28`, hour: 12, firstAt: `${YEAR + 5}-12-28T00:00:00Z` },
        recapStopSaved: false
    });
    await openSection(page, 'recap');
    await page.locator('#recap-section [data-action="recap-send-open"]').click();
    const dialog = page.locator('#recap-send-modal');
    await dialog.locator('[data-action="recap-send-all"]').click();
    await page.locator('#modal-confirm-btn').click();
    await dialog.locator('[data-action="recap-send-stop"]').click();
    await expect(page.locator('.toast', { hasText: 'sending by date turned off' })).toBeVisible();
    await expect(page.locator('.toast', { hasText: "off until a restart: .env couldn't be written" })).toBeVisible();
});
