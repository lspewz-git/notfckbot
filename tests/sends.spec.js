const { test, expect } = require('@playwright/test');
const { watchConsole } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * The dashboard's notifications chart: a day's bar opens what didn't reach its chat and why, and
 * today's what waits for the next check (admin/js/sends.js), on the API mock.
 */

// A 500 the browser reports itself: the test of details that fail to load asks for one
watchConsole({ ignore: /500/ });

// tests/mock-panel.js charts(): 30 days from 15 Sep, counted from 20 Sep, the 10th (24 Sep) with
// one not delivered
const FAILED_DAY = '2026-09-24';
const TODAY = '2026-10-14';

const SENDS = (day) => ({
    day,
    keptSince: '2026-09-20',
    failed:
        day === FAILED_DAY
            ? [
                  {
                      chatId: '-100',
                      chat: 'miners_otdihayt',
                      about: 'Голодные игры: Рассвет жатвы',
                      status: 'gave_up',
                      error: 'No answer from Telegram in 30 s',
                      count: 1,
                      tries: 8,
                      since: '2026-09-23T03:01:00Z',
                      at: '2026-09-24T06:00:00Z'
                  }
              ]
            : [],
    queued:
        day === TODAY
            ? [
                  {
                      chatId: '-100',
                      chat: 'miners_otdihayt',
                      about: 'Темная материя',
                      error: 'Telegram was unreachable earlier in this check',
                      tries: 0,
                      maxTries: 8,
                      since: '2026-10-14T03:01:00Z'
                  }
              ]
            : [],
    nextCheckAt: '2026-10-14T09:00:00Z'
});

/** Clicks the chart's column for the day at `index`, where Chart.js put it. */
async function clickDay(page, index) {
    const canvas = page.locator('#chart-sent');
    await expect
        .poll(() => page.evaluate(() => Boolean(window.Chart && window.Chart.getChart('chart-sent'))))
        .toBe(true);
    const x = await page.evaluate((i) => window.Chart.getChart('chart-sent').getDatasetMeta(0).data[i].x, index);
    // On a phone the chart is below the fold: a click by coordinates doesn't scroll
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    // Halfway up the plot: the column counts, not only the bar (a day of 0 has none)
    await page.mouse.click(box.x + x, box.y + box.height / 3);
}

/** Chart.js takes the click on its next frame: the dialog is open and its rows are in. */
async function detailsLoaded(page) {
    await expect(page.locator('#sends-modal')).toBeVisible();
    await expect(page.locator('#sends-body .skeleton')).toHaveCount(0);
}

test("a day's bar opens what didn't go out, with the title, the chat and why", async ({ page }) => {
    const panel = await mockPanel(page, { sends: SENDS });
    await clickDay(page, 9);
    const dialog = page.locator('#sends-modal');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#sends-title')).toHaveText('24 Sep');
    await expect(page.locator('#sends-sub')).toHaveText(/Not delivered 1/);
    const row = dialog.locator('.sends-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.sends-title')).toHaveText('Голодные игры: Рассвет жатвы → miners_otdihayt');
    await expect(row.locator('.sends-meta')).toContainText('Gave up after 8 tries since 23 Sep');
    await expect(row.locator('.sends-meta')).toContainText('No answer from Telegram in 30 s');
    expect(panel.sendsAsked).toEqual([FAILED_DAY]);
});

test('the "Not delivered" card, with none in its week, opens today from the keyboard too: the queue', async ({
    page
}) => {
    const panel = await mockPanel(page, { sends: SENDS });
    const today = page.locator('.stat-card[data-action="sends-recent"]');
    await expect(today).toContainText('Not delivered, 7 days');
    await today.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sends-title')).toHaveText('14 Oct');
    await expect(page.locator('#sends-sub')).toHaveText(/Waiting to resend 1/);
    await expect(page.locator('.sends-group', { hasText: 'Waiting to resend' })).toContainText('at the next check');
    await expect(page.locator('.sends-row .sends-meta')).toContainText('Try 1 of 8');
    // The chart's last day asks with the queue, whatever the server's date
    expect(panel.sendsAsked).toEqual([TODAY]);
});

test('the "Not delivered" card opens the latest day of its week that had one, not an empty today', async ({
    page
}) => {
    const charts = (data) => {
        // 12 Oct, two days before today, had two
        data.days[27].failed = 2;
        return data;
    };
    const panel = await mockPanel(page, { sends: SENDS, charts });
    await page.locator('.stat-card[data-action="sends-recent"]').click();
    await expect(page.locator('#sends-title')).toHaveText('12 Oct');
    expect(panel.sendsAsked).toEqual(['2026-10-12']);
});

test("a chat that left the bot, a held list of three, a chat without a name", async ({ page }) => {
    const gone = (day) => ({
        ...SENDS(day),
        failed: [
            {
                chatId: '-200',
                chat: null,
                about: '3 notifications held overnight',
                status: 'gone',
                error: '403: Forbidden: bot was kicked',
                count: 3,
                tries: 0,
                since: null,
                at: '2026-09-24T06:00:00Z'
            }
        ]
    });
    await mockPanel(page, { sends: gone });
    await clickDay(page, 9);
    await detailsLoaded(page);
    const row = page.locator('.sends-row');
    // No name known: the chat's id
    await expect(row.locator('.sends-title')).toHaveText('3 notifications held overnight (3) → -200');
    await expect(row.locator('.sends-meta')).toContainText('The chat blocked or removed the bot');
});

test('the details failing to load: a dead end, not a skeleton forever', async ({ page }) => {
    await mockPanel(page, { failing: ['/api/stats/sends'] });
    await clickDay(page, 9);
    await expect(page.locator('#sends-body')).toContainText('Failed to load');
    await expect(page.locator('#sends-body .skeleton')).toHaveCount(0);
});

test('a day before the counting began opens nothing: there is nothing to tell', async ({ page }) => {
    const panel = await mockPanel(page, { sends: SENDS });
    // tests/mock-panel.js: counting since the 6th day (20 Sep)
    await clickDay(page, 3);
    await expect(page.locator('#sends-modal')).toBeHidden();
    expect(panel.sendsAsked).toBeUndefined();
});

test('a day counted before the details were kept says so instead of an empty list', async ({ page }) => {
    // The chart counts one for 24 Sep; the server keeps no row for it
    await mockPanel(page, { sends: (day) => ({ ...SENDS(day), failed: [], keptSince: '2026-10-01' }) });
    await clickDay(page, 9);
    await expect(page.locator('#sends-body')).toContainText('1 more without details: details are kept since 1 Oct');
});

test('a day where everything went out says so', async ({ page }) => {
    await mockPanel(page);
    await clickDay(page, 6);
    await expect(page.locator('#sends-body')).toHaveText('Everything went out.');
});
