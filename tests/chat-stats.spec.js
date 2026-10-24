const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel, chatStats } = require('./mock-panel');

/**
 * A chat's statistics (Chats → actions → Statistics) on the canned API: the year's figures, the
 * period switch, a slow or failed answer.
 */

// The failed-answer test's 500 is one the browser reports itself
watchConsole({ ignore: /500/ });

const YEAR = new Date().getFullYear();

async function openStats(page, chatId) {
    await openSection(page, 'chats');
    await page.locator(`[data-action="chat-actions"][data-id="${chatId}"]`).click();
    await page.locator('#action-stats').click();
    await expect(page.locator('#chat-stats-modal')).toBeVisible();
}

test("a group's year: the figures, its tastes by name, its members", async ({ page }) => {
    const panel = await mockPanel(page);
    await openStats(page, -1003);
    const body = page.locator('#chat-stats-body');
    await expect(page.locator('#chat-stats-sub')).toHaveText('Movie Club · supergroup');
    await expect(body.locator('.stats-kpi-value')).toHaveText(['187', '142', '214', '23']);
    await expect(body.locator('.stats-kpi-note').nth(2)).toHaveText('31 after quiet hours · 2 lost');
    await expect(body.locator('.stats-chart-box .stats-box-title span')).toHaveText('busiest: Mar, 34');
    await expect(body.locator('.stats-col-label')).toHaveCount(12);
    // TMDB's genres come lower case; countries as codes
    await expect(body.locator('.stats-cols-3 .stats-box').nth(0).locator('.stats-name')).toHaveText([
        'Драма',
        'Криминал'
    ]);
    await expect(body.locator('.stats-cols-3 .stats-box').nth(2).locator('.stats-name')).toHaveText([
        'United States',
        'South Korea'
    ]);
    // Who added the most (★: clearly ahead) and who used the bot the most, apart
    const added = body.locator('.stats-subtitle', { hasText: 'Added most' }).locator('+ .stats-list .stats-row');
    await expect(added).toHaveText(['★@masha6 series · 3 films', '@ann4 series']);
    const used = body.locator('.stats-subtitle', { hasText: 'Used the bot most' }).locator('+ .stats-list .stats-row');
    await expect(used).toHaveText(['@ann36 times']);
    await expect(body.locator('.stats-row', { hasText: 'Dune: Messiah' })).toContainText('waited 412 days');
    await expect(body.locator('.stats-note')).toHaveText(
        'Notifications, bot use and who added what are counted since 23 Oct 2026, when recording began.'
    );
    expect(panel.statsAsked).toEqual([{ chatId: '-1003', query: `year=${YEAR}` }]);
});

test('a private chat has no members list; the periods ask for their own days', async ({ page }) => {
    const panel = await mockPanel(page);
    await openStats(page, 101);
    await expect(page.locator('#chat-stats-body .stats-kpi-value').first()).toHaveText('187');
    await expect(page.locator('#chat-stats-body .stats-subtitle', { hasText: /Added most|Used the bot/ })).toHaveCount(0);

    await page.locator('#chat-stats-periods .btn', { hasText: String(YEAR - 1) }).click();
    await expect(page.locator('#chat-stats-periods .btn.active')).toHaveText(String(YEAR - 1));
    await page.locator('#chat-stats-periods .btn', { hasText: 'All time' }).click();
    await expect(page.locator('#chat-stats-periods .btn.active')).toHaveText('All time');
    await expect.poll(() => panel.statsAsked.length).toBe(3);
    expect(panel.statsAsked[1].query).toBe(`year=${YEAR - 1}`);
    expect(panel.statsAsked[2].query).toMatch(/^from=2000-01-01&to=\d{4}-\d{2}-\d{2}$/);
});

test('a slow answer for the old period never replaces the new one', async ({ page }) => {
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    // This year's answer comes last, after last year's: the dialog stays on last year
    await mockPanel(page, {
        chatStats: async (query) => {
            const stats = chatStats(query);
            if (query !== `year=${YEAR}`) return stats;
            await slow;
            return { ...stats, episodes: { ...stats.episodes, count: 1 } };
        }
    });
    await openStats(page, 101);
    await page.locator('#chat-stats-periods .btn', { hasText: String(YEAR - 1) }).click();
    await expect(page.locator('#chat-stats-body .stats-kpi-value').first()).toHaveText('187');
    release();
    await page.waitForTimeout(300);
    await expect(page.locator('#chat-stats-body .stats-kpi-value').first()).toHaveText('187');
});

test('while loading the dialog keeps its size', async ({ page }) => {
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    await mockPanel(page, { statsHold: hold });
    await openStats(page, -1003);
    const body = page.locator('#chat-stats-body');
    await expect(body).toHaveAttribute('aria-busy', 'true');
    await expect(body.locator('.stats-kpi .skeleton').first()).toBeVisible();
    // offsetHeight: the dialog's opening animation scales it, the layout stays
    const loading = await body.evaluate((el) => /** @type {HTMLElement} */ (el).offsetHeight);
    release();
    await expect(body.locator('.stats-kpi-value').first()).toHaveText('187');
    const loaded = await body.evaluate((el) => /** @type {HTMLElement} */ (el).offsetHeight);
    expect(Math.abs(loaded - loading)).toBeLessThanOrEqual(2);
});

test('a failed answer: a note instead of figures, and closing goes back to the chat menu', async ({ page }) => {
    await mockPanel(page, { failing: ['/api/chat/101/stats'] });
    await openStats(page, 101);
    await expect(page.locator('#chat-stats-body .stats-failed')).toContainText('Failed to load');
    await page.locator('#chat-stats-modal .modal-x').click();
    await expect(page.locator('#chat-stats-modal')).toBeHidden();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});

test("the year's recap: six cards of the period's year, and back to the statistics, then the menu", async ({
    page
}) => {
    const panel = await mockPanel(page);
    await openStats(page, -1003);
    const button = page.locator('#chat-stats-recap');
    await expect(button).toHaveText(`Preview ${YEAR} recap`);
    await page.locator('#chat-stats-periods .btn', { hasText: String(YEAR - 1) }).click();
    await expect(button).toHaveText(`Preview ${YEAR - 1} recap`);

    await button.click();
    const recap = page.locator('#recap-modal');
    await expect(recap).toBeVisible();
    await expect(page.locator('#chat-stats-modal')).toBeHidden();
    await expect(page.locator('#recap-title')).toHaveText(`${YEAR - 1} recap`);
    await expect(page.locator('#recap-sub')).toHaveText('Movie Club');
    await expect(recap.locator('.recap-card img')).toHaveCount(6);
    expect(panel.recapAsked.map((r) => [r.chatId, r.n, r.query])).toEqual(
        [1, 2, 3, 4, 5, 6].map((n) => ['-1003', n, `year=${YEAR - 1}`])
    );
    // The cards keep the 4:5 shape whatever the image
    const box = await recap.locator('.recap-card').first().boundingBox();
    expect(Math.abs(box.height / box.width - 1.25)).toBeLessThan(0.02);

    await recap.locator('.modal-x').click();
    await expect(page.locator('#chat-stats-modal')).toBeVisible();
    await page.locator('#chat-stats-modal .modal-x').click();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});
