const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, isNarrow } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Year recap section on the canned API: what each card is drawn on (Backgrounds: pictures, the
 * picker, upload, delete) and the sets drawn so far (Ready cards: states, draw, view, delete).
 */

// A refused save (400) and a failed load (500) are errors the browser reports itself
watchConsole({ ignore: /status of (400|500)/ });

const YEAR = new Date().getFullYear();
// A real PNG header and a few bytes: the mock only looks at the request
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function openRecap(page) {
    await openSection(page, 'recap');
    await expect(page.locator('#recap-section')).toHaveClass(/active/);
    await expect(page.locator('#recap-slots .recap-slot-name')).toHaveCount(6);
    await expect(page.locator('#recap-slots')).toHaveAttribute('aria-busy', 'false');
}

test('Backgrounds: the six cards with what each is drawn on, and the pictures with the cards using them', async ({
    page
}) => {
    await mockPanel(page);
    await openRecap(page);
    await expect(page.locator('.recap-slot-what')).toHaveText([
        'Sunset.jpg',
        'Plain colour',
        'Stripes.png · dimmed 35%',
        'Plain colour',
        'Plain colour',
        'Plain colour'
    ]);
    await expect(page.locator('.recap-picture-meta b')).toHaveText(['Sunset.jpg', 'Stripes.png']);
    await expect(page.locator('.recap-picture-meta span')).toHaveText(['card 1', 'card 3']);
    // Nothing scrolls sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('the picker: a picture and a dim, the card drawn for a real chat each time, then saved for the card', async ({
    page
}) => {
    const panel = await mockPanel(page);
    await openRecap(page);
    await page.locator('.recap-slot-change[data-card="2"]').click();
    const dialog = page.locator('#recap-look-modal');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#recap-look-title')).toHaveText('Card 2 · Episodes');
    await expect(page.locator('#recap-look-sub')).toHaveText(`Drawn for Movie Club, ${YEAR}`);
    await expect(page.locator('#recap-look-preview img')).toBeVisible();
    // Plain colour: no dim to set
    await expect(page.locator('#recap-dim')).toBeDisabled();

    await dialog.locator('[data-action="recap-look-pick"][data-id="aaaaaaaaaaaaaaaa"]').click();
    await expect(page.locator('#recap-dim')).toBeEnabled();
    await page.locator('#recap-dim').fill('40');
    await expect(page.locator('#recap-dim-value')).toHaveText('40%');
    await expect
        .poll(() => (panel.recapPreviews || []).at(-1))
        .toEqual({ card: 2, background: 'aaaaaaaaaaaaaaaa', dim: '40' });

    await page.locator('#recap-look-save').click();
    await expect(dialog).toBeHidden();
    expect(panel.recapLookSaved).toEqual({ card: 2, background: 'aaaaaaaaaaaaaaaa', dim: 40 });
    await expect(page.locator('.recap-slot-what').nth(1)).toHaveText('Sunset.jpg · dimmed 40%');
});

test('upload: a PNG goes as a form and shows in the list; another type is refused before sending', async ({ page }) => {
    const panel = await mockPanel(page);
    await openRecap(page);
    await page.locator('#recap-upload').setInputFiles({ name: 'new.gif', mimeType: 'image/gif', buffer: PNG });
    await expect(page.locator('.toast', { hasText: 'A PNG or JPEG picture, please' })).toBeVisible();
    expect(panel.recapUploads).toBeUndefined();

    await page.locator('#recap-upload').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('.recap-picture-meta b').first()).toHaveText('upload.png');
    expect(panel.recapUploads).toBe(1);
    expect(panel.recapUploadType).toMatch(/^multipart\/form-data; boundary=/);
});

test('deleting a picture asks first; its card goes back to its colour', async ({ page }) => {
    const panel = await mockPanel(page);
    await openRecap(page);
    await page.locator('[data-action="recap-picture-delete"][data-id="bbbbbbbbbbbbbbbb"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Delete Stripes.png?');
    await expect(page.locator('#confirm-text')).toContainText('Card 3 goes back to its plain colour');
    await page.locator('#modal-cancel-btn').click();
    expect(panel.recapPictureDeleted).toBeUndefined();

    await page.locator('[data-action="recap-picture-delete"][data-id="bbbbbbbbbbbbbbbb"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.recap-slot-what').nth(2)).toHaveText('Plain colour');
    expect(panel.recapPictureDeleted).toBe('bbbbbbbbbbbbbbbb');
    await expect(page.locator('.recap-picture-meta b')).toHaveText(['Sunset.jpg']);
});

test('Ready cards: the counts, a row per chat with its state, every row on the same columns', async ({ page }) => {
    await mockPanel(page);
    await openRecap(page);
    await page.locator('[data-action="recap-tab"][data-tab="ready"]').click();
    await expect(page.locator('#recap-ready-list .recap-tag')).toHaveText(['Ready', 'Out of date', 'Not drawn']);
    await expect(page.locator('.recap-stat b')).toHaveText(['1', '1', '1', '818 KB']);
    await expect(page.locator('[data-action="recap-draw"]').first()).toHaveText('Draw missing and out of date (2)');
    // The six small copies of a drawn set; six empty places for the one not drawn
    await expect(page.locator('#recap-ready-list li').nth(0).locator('.recap-strip-card img')).toHaveCount(6);
    await expect(page.locator('#recap-ready-list li').nth(2).locator('.recap-strip-card')).toHaveCount(6);
    if (!isNarrow(page)) {
        const lefts = await page
            .locator('#recap-ready-list .recap-row-state')
            .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
        expect(new Set(lefts).size).toBe(1);
    }
});

test('Ready cards: draw what is missing, delete one or all (each asked first), view opens the preview', async ({
    page
}) => {
    const panel = await mockPanel(page);
    await openRecap(page);
    await page.locator('[data-action="recap-tab"][data-tab="ready"]').click();
    await expect(page.locator('#recap-ready-list .recap-tag')).toHaveCount(3);

    await page.locator('#recap-ready-summary [data-action="recap-draw"]').click();
    expect(panel.recapDraws).toEqual([{ year: YEAR }]);
    await expect(page.locator('#recap-ready-summary .btn[aria-busy="true"]')).toHaveText('Drawing… 2 left');
    panel.recapReady.drawing = { running: false, left: 0 };

    await page.locator('[data-action="recap-view"][data-chat="-1003"]').click();
    await expect(page.locator('#recap-modal')).toBeVisible();
    await expect(page.locator('#recap-sub')).toHaveText('Movie Club');
    await page.locator('#recap-modal .modal-x').click();
    await expect(page.locator('#recap-modal')).toBeHidden();

    await page.locator('[data-action="recap-delete"][data-chat="101"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Delete the cards of alice?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#recap-ready-list .recap-tag').nth(1)).toHaveText('Not drawn');
    expect(panel.recapDeleted).toBe('101');

    await page.locator('[data-action="recap-delete-all"]').click();
    await expect(page.locator('#confirm-title')).toHaveText(`Delete the ${YEAR} cards of 1 chat?`);
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#recap-ready-list .recap-tag')).toHaveText(['Not drawn', 'Not drawn', 'Not drawn']);
    expect(panel.recapDeletedAll).toBe(true);
});

async function openSchedule(page) {
    await openRecap(page);
    await page.locator('#recap-section [data-action="recap-tab"][data-tab="schedule"]').click();
    await expect(page.locator('#recap-sched-pane')).toHaveAttribute('aria-busy', 'false');
}

test('Schedule: off, with 28 December and 12:00 offered; showing it saves nothing, a pick saves at once', async ({
    page
}) => {
    const panel = await mockPanel(page);
    await openSchedule(page);
    await expect(page.locator('#recap-sched-state')).toContainText('Off');
    // The schedule has its own year: the year buttons go
    await expect(page.locator('#recap-years')).toBeHidden();
    await expect(page.locator('#recap-sched-pane .custom-select-trigger')).toHaveText([`28 December ${YEAR}`, '12:00']);
    await expect(page.locator('#recap-sched-year')).toHaveText(
        `Sends the ${YEAR} recap, at 12:00 in each chat's time zone.`
    );
    await expect(page.locator('#recap-sched-who li').first()).toHaveText('Will get it3 chats');
    expect(panel.recapScheduleSaves).toEqual([]);

    await page.locator('#recap-sched-pane .custom-select-trigger').nth(1).click();
    await page.locator('.custom-select-option', { hasText: '18:00' }).click();
    await expect.poll(() => panel.recapScheduleSaves).toEqual([{ on: false, day: `${YEAR}-12-28`, hour: 18 }]);
    // A January day sends the year before
    await page.locator('#recap-sched-pane .custom-select-trigger').first().click();
    await page.locator('.custom-select-option', { hasText: `5 January ${YEAR + 1}` }).click();
    await expect(page.locator('#recap-sched-year')).toContainText(`Sends the ${YEAR} recap`);
    expect(panel.recapScheduleSaves.at(-1)).toEqual({ on: false, day: `${YEAR + 1}-01-05`, hour: 18 });
});

test('Schedule: turning on asks first and says when and to how many; then the day is locked', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSchedule(page);
    const sw = page.locator('#recap-sched-switch');
    await sw.click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await expect(page.locator('#confirm-title')).toHaveText(`Send the ${YEAR} recap on 28 Dec?`);
    await expect(page.locator('#confirm-text')).toContainText("At 12:00 in each chat's time zone, 3 chats");
    // Cancel: nothing saved
    await page.locator('#modal-cancel-btn').click();
    expect(panel.recapScheduleSaves).toEqual([]);
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    await sw.click();
    await page.locator('#modal-confirm-btn').click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(panel.recapScheduleSaves).toEqual([{ on: true, day: `${YEAR}-12-28`, hour: 12 }]);
    await expect(page.locator('#recap-sched-state')).toContainText(`On: 28 December ${YEAR}, 12:00 chat's time`);
    await expect(page.locator('#recap-sched-state')).toContainText('until the first chat');
    await expect(page.locator('#recap-sched-pane .custom-select-trigger').first()).toBeDisabled();

    // Off: no question, the day stays
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(panel.recapScheduleSaves.at(-1)).toEqual({ on: false, day: `${YEAR}-12-28`, hour: 12 });
    await expect(page.locator('.toast', { hasText: 'Scheduled sending is off' })).toBeVisible();
    await expect(page.locator('#recap-sched-pane .custom-select-trigger').first()).toBeEnabled();
});

test('Schedule: a refused save says why and the fields go back', async ({ page }) => {
    await mockPanel(page, { recapScheduleError: 'That day and hour have passed or are less than an hour away' });
    await openSchedule(page);
    await page.locator('#recap-sched-pane .custom-select-trigger').nth(1).click();
    await page.locator('.custom-select-option', { hasText: '07:00' }).click();
    await expect(page.locator('.toast', { hasText: 'less than an hour away' })).toBeVisible();
    await expect(page.locator('#recap-sched-pane .custom-select-trigger').nth(1)).toHaveText('12:00');
});

test('Schedule: after the day it says it was sent; while sending it shows how far it is', async ({ page }) => {
    const progress = { queued: 1, sending: 0, sent: 2, failed: 0, quiet: 1, total: 3, running: true };
    await mockPanel(page, {
        recapSchedule: {
            on: false,
            done: true,
            day: `${YEAR}-12-28`,
            hour: 12,
            progress: { ...progress, queued: 0, sent: 3 }
        }
    });
    await openSchedule(page);
    await expect(page.locator('#recap-sched-state')).toContainText(`Sent on 28 December ${YEAR}`);
    await expect(page.locator('#recap-sched-state')).toContainText('3 chats got it');
    await expect(page.locator('#recap-sched-switch')).toHaveAttribute('aria-checked', 'false');
});

test('Schedule: on, with the first hour passed: the progress line', async ({ page }) => {
    await mockPanel(page, {
        recapSchedule: {
            on: true,
            day: `${YEAR}-12-28`,
            hour: 12,
            firstAt: '2000-01-01T00:00:00Z',
            lastAt: '2000-01-01T10:00:00Z',
            progress: { queued: 1, sending: 0, sent: 2, failed: 0, quiet: 1, total: 3, running: true }
        }
    });
    await openSchedule(page);
    await expect(page.locator('#recap-sched-state')).toContainText(
        'Sending: 2 of 3 sent · 1 waiting for quiet hours to end'
    );
});

test('Schedule: failed to load: a dead end, nothing to pick or switch', async ({ page }) => {
    await mockPanel(page, { failing: ['/api/recap/schedule'] });
    await openRecap(page);
    await page.locator('#recap-section [data-action="recap-tab"][data-tab="schedule"]').click();
    await expect(page.locator('#recap-sched-pane')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#recap-sched-state')).toContainText('Failed to load');
    await expect(page.locator('#recap-sched-switch')).toBeDisabled();
    await expect(page.locator('#recap-sched-who')).toHaveText('Failed to load-');
    await expect(page.locator('#recap-sched-pane .skeleton')).toHaveCount(0);
});

test('Schedule: turned off during the sending, it says what is still queued and how to stop it', async ({ page }) => {
    await mockPanel(page, {
        recapSchedule: {
            on: false,
            day: `${YEAR}-12-28`,
            hour: 12,
            progress: { queued: 2, sending: 0, sent: 1, failed: 0, quiet: 0, total: 3, running: true }
        }
    });
    await openSchedule(page);
    await expect(page.locator('#recap-sched-state')).toContainText(
        '2 chats already queued still go out; Stop in the Send window takes them off.'
    );
});

test('Schedule: turned off between the first and the last hour: the rest must be sent by hand', async ({ page }) => {
    const now = Date.now();
    await mockPanel(page, {
        recapSchedule: {
            on: false,
            day: `${YEAR}-12-28`,
            hour: 12,
            firstAt: new Date(now - 3600000).toISOString(),
            lastAt: new Date(now + 3600000).toISOString()
        }
    });
    await openSchedule(page);
    await expect(page.locator('#recap-sched-state')).toContainText(
        "Chats whose hour hasn't come won't get it by date: send them by hand."
    );
});
