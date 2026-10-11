const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * The Active / Archive split of the Serials section (subscriptions) and the
 * dashboard figure behind it, plus the Next Episode column.
 * Needs a known mix of ended and running shows, so unlike
 * admin.spec.js this runs against a canned API (see mock-panel.js).
 *
 * Fixture: 23 subscriptions, 6 of them to Ended/Canceled series.
 */

const ACTIVE = 17;
const ARCHIVED = 6;
// Rows per page until the user picks another size
const PAGE = 10;

/** Rows are hidden (by the filter or the pager) with inline display:none, which older Playwright cannot filter on. */
function visibleRows(page) {
    return page.locator('#subs-body tr').evaluateAll((rows) => rows.filter((r) => r.style.display !== 'none').length);
}

async function goToSubs(page) {
    const narrow = page.viewportSize().width <= 1024;
    await page.locator(`${narrow ? '.tab-item' : '.nav-item'}[data-section="subs"]`).click();
    await expect(page.locator('#subs-section')).toHaveClass(/active/);
    await expect(page.locator('#subs-body .skeleton-row')).toHaveCount(0, { timeout: 15_000 });
}

const tab = (page, name) => page.locator(`.tab-filters [data-subs-tab="${name}"]`);

let panel;

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    panel = await mockPanel(page);
    await expect(page.locator('#chats-count')).not.toHaveText('-');
    page.__errors = errors;
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'console should stay clean').toEqual([]);
});

test('the dashboard counts only active subscriptions and notes the archived ones', async ({ page }) => {
    await expect(page.locator('#subs-count')).toHaveText(String(ACTIVE));
    await expect(page.locator('#subs-archived-count')).toBeVisible();
    await expect(page.locator('#subs-archived-count')).toHaveText(`+ ${ARCHIVED} archived`);
});

test('the tabs show counts and split the rows', async ({ page }) => {
    await goToSubs(page);
    await expect(page.locator('#subs-section h1')).toHaveText('Serials');

    await expect(tab(page, 'active')).toHaveText(`Active (${ACTIVE})`);
    await expect(tab(page, 'archive')).toHaveText(`Archive (${ARCHIVED})`);
    await expect(tab(page, 'active')).toHaveAttribute('aria-pressed', 'true');

    // Active is the default; a not-yet-checked status counts as active
    await expect(page.locator('#subs-body tr')).toHaveCount(ACTIVE);
    await expect(page.locator('#subs-body')).toContainText('Brand New Show');
    await expect(page.locator('#subs-body [data-action="mode"]')).toHaveCount(ACTIVE);
    await expect(page.locator('#subs-archive-hint')).toBeHidden();

    await tab(page, 'archive').click();
    await expect(tab(page, 'archive')).toHaveClass(/active/);
    await expect(tab(page, 'archive')).toHaveAttribute('aria-pressed', 'true');
    await expect(tab(page, 'active')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#subs-body tr')).toHaveCount(ARCHIVED);
    await expect(page.locator('#subs-archive-hint')).toBeVisible();

    const statuses = await page.locator('#subs-body [data-label="Status"]').allInnerTexts();
    expect(statuses.every((s) => /Ended|Canceled/.test(s))).toBe(true);
});

test('archived rows can be deleted but offer no mode', async ({ page }) => {
    await goToSubs(page);
    await tab(page, 'archive').click();
    await expect(page.locator('#subs-body tr')).toHaveCount(ARCHIVED);

    await expect(page.locator('#subs-body [data-action="mode"]')).toHaveCount(0);
    await expect(page.locator('#subs-body [data-label="Mode"]')).toHaveCount(0);
    await expect(page.locator('#subs-body [data-action="delete-sub"]')).toHaveCount(ARCHIVED);
    await expect(page.locator('#subs-table th.col-mode')).toBeHidden();
    // Nothing more will air, so no Next Episode either
    await expect(page.locator('#subs-body [data-label="Next Episode"]')).toHaveCount(0);
    await expect(page.locator('#subs-table th.col-next')).toBeHidden();

    // Back on Active the columns return
    await tab(page, 'active').click();
    await expect(page.locator('#subs-body [data-label="Mode"]')).toHaveCount(ACTIVE);
    await expect(page.locator('#subs-body [data-label="Next Episode"]')).toHaveCount(ACTIVE);
});

test('Next Episode shows the announced episode, or TBA', async ({ page }) => {
    await goToSubs(page);
    const nextOf = (title) =>
        page.locator('#subs-body tr', { hasText: title }).first().locator('[data-label="Next Episode"]');

    await expect(nextOf('Severance')).toHaveText('S3E2 · 15 Oct 2026');
    // Numbered but not dated yet
    await expect(nextOf('The Boys')).toHaveText('S5E1 · TBA');
    // Season 0 is TMDB's specials, a real season number
    await expect(nextOf('Stranger Things')).toHaveText('S0E3 · 25 Dec 2026');
    await expect(nextOf('House of the Dragon')).toHaveText('TBA');
});

test('the text filter works within the selected tab', async ({ page }) => {
    await goToSubs(page);
    await tab(page, 'archive').click();

    // A running show is not in the archive, whatever the filter says
    await page.locator('#subs-filter').fill('Stranger');
    await expect.poll(() => visibleRows(page)).toBe(0);

    await page.locator('#subs-filter').fill('Loki');
    await expect.poll(() => visibleRows(page)).toBe(2);

    // The filter survives a tab switch
    await tab(page, 'active').click();
    await expect.poll(() => visibleRows(page)).toBe(0);
    await page.locator('#subs-filter').fill('Stranger');
    await expect.poll(() => visibleRows(page)).toBe(3);

    await page.locator('#subs-filter').fill('');
    await expect.poll(() => visibleRows(page)).toBe(PAGE);
});

test.describe('pages', () => {
    const pager = (page) => page.locator('#subs-pager');
    const info = (page) => pager(page).locator('.pager-info');
    const prev = (page) => pager(page).locator('[data-step="-1"]');
    const next = (page) => pager(page).locator('[data-step="1"]');

    async function pickSize(page, size) {
        await pager(page).locator('.custom-select-trigger').click();
        await page.locator('.custom-select-panel [role="option"]', { hasText: new RegExp(`^${size}$`) }).click();
    }

    test('ten rows a page, arrows move between pages', async ({ page }) => {
        await goToSubs(page);
        await expect(info(page)).toHaveText(`1–${PAGE} of ${ACTIVE}`);
        await expect.poll(() => visibleRows(page)).toBe(PAGE);
        await expect(prev(page)).toBeDisabled();
        await expect(next(page)).toBeEnabled();

        await next(page).click();
        await expect(info(page)).toHaveText(`${PAGE + 1}–${ACTIVE} of ${ACTIVE}`);
        await expect.poll(() => visibleRows(page)).toBe(ACTIVE - PAGE);
        await expect(next(page)).toBeDisabled();

        await prev(page).click();
        await expect(info(page)).toHaveText(`1–${PAGE} of ${ACTIVE}`);
    });

    test('the filter, a tab switch and a new size start again from page one', async ({ page }) => {
        await goToSubs(page);
        await next(page).click();

        await page.locator('#subs-filter').fill('Stranger');
        await expect(info(page)).toHaveText('1–3 of 3');
        await page.locator('#subs-filter').fill('');
        await expect(info(page)).toHaveText(`1–${PAGE} of ${ACTIVE}`);

        await next(page).click();
        await tab(page, 'archive').click();
        await expect(info(page)).toHaveText(`1–${ARCHIVED} of ${ARCHIVED}`);
        await tab(page, 'active').click();
        await expect(info(page)).toHaveText(`1–${PAGE} of ${ACTIVE}`);

        await next(page).click();
        await pickSize(page, 25);
        await expect(info(page)).toHaveText(`1–${ACTIVE} of ${ACTIVE}`);
        await expect.poll(() => visibleRows(page)).toBe(ACTIVE);
        await expect(next(page)).toBeDisabled();
    });

    test('the chosen size is remembered', async ({ page }) => {
        await goToSubs(page);
        await pickSize(page, 50);
        await page.reload();
        await goToSubs(page);
        await expect(pager(page).locator('.custom-select-trigger')).toHaveText('50');
        await expect(info(page)).toHaveText(`1–${ACTIVE} of ${ACTIVE}`);
    });

    test('no pager when there is nothing to show', async ({ page }) => {
        panel.subs = panel.subs.filter((s) => !['Ended', 'Canceled'].includes(s.Series.status));
        await goToSubs(page);
        await tab(page, 'archive').click();
        await expect(pager(page)).toBeHidden();
    });
});

test('the selected tab survives the auto-refresh, with or without new data', async ({ page }) => {
    // Drive the real 10-second poll instead of waiting for it
    await page.clock.install();
    await page.reload();
    await page.locator('#pause-refresh').click();
    await expect(page.locator('#pause-refresh')).toHaveText('Pause');

    await goToSubs(page);
    await tab(page, 'archive').click();
    await expect(page.locator('#subs-body tr')).toHaveCount(ARCHIVED);

    const poll = async () => {
        const request = page.waitForRequest('**/api/data/subs');
        await page.clock.runFor(10_000);
        await (await request).response();
    };

    // Same payload: nothing may be rebuilt back into the Active view
    await poll();
    await expect(tab(page, 'archive')).toHaveClass(/active/);
    await expect(page.locator('#subs-body tr')).toHaveCount(ARCHIVED);

    // A show gets canceled between polls
    panel.subs = panel.subs.map((s) =>
        s.seriesId === '94997' ? { ...s, Series: { ...s.Series, status: 'Canceled' } } : s
    );
    await poll();
    await expect(tab(page, 'archive')).toHaveText(`Archive (${ARCHIVED + 2})`);
    await expect(tab(page, 'active')).toHaveText(`Active (${ACTIVE - 2})`);
    await expect(tab(page, 'archive')).toHaveClass(/active/);
    await expect(page.locator('#subs-body tr')).toHaveCount(ARCHIVED + 2);
    await expect(page.locator('#subs-body [data-action="mode"]')).toHaveCount(0);
});

test('an empty tab says so', async ({ page }) => {
    panel.subs = panel.subs.filter((s) => !['Ended', 'Canceled'].includes(s.Series.status));
    await goToSubs(page);
    await tab(page, 'archive').click();
    await expect(tab(page, 'archive')).toHaveText('Archive (0)');
    await expect(page.locator('#subs-body')).toHaveText('No archived subscriptions.');
});

test('the dashboard card opens the Active tab', async ({ page }) => {
    await goToSubs(page);
    await tab(page, 'archive').click();

    const narrow = page.viewportSize().width <= 1024;
    await page.locator(`${narrow ? '.tab-item' : '.nav-item'}[data-section="dashboard"]`).click();
    await page.locator('.stat-card[data-section="subs"]').click();

    await expect(page.locator('#subs-section')).toHaveClass(/active/);
    await expect(tab(page, 'active')).toHaveClass(/active/);
    await expect(page.locator('#subs-body tr')).toHaveCount(ACTIVE);
});

for (const [width, height] of [
    [375, 812],
    [768, 1024]
]) {
    test.describe(`at ${width}px`, () => {
        test.use({ viewport: { width, height } });

        test('nothing scrolls sideways and the tabs sit on one row', async ({ page }) => {
            const overflows = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

            await expect(page.locator('#subs-archived-count')).toBeVisible();
            expect(await overflows(), 'dashboard').toBe(false);

            await goToSubs(page);
            expect(await overflows(), 'active tab').toBe(false);

            const [a, b] = await Promise.all([tab(page, 'active').boundingBox(), tab(page, 'archive').boundingBox()]);
            expect(Math.round(a.y)).toBe(Math.round(b.y));
            // Full-width segmented control: equal halves, thumb-sized
            expect(Math.abs(a.width - b.width)).toBeLessThan(2);
            expect(a.height).toBeGreaterThanOrEqual(40);

            await tab(page, 'archive').click();
            await expect(page.locator('#subs-body tr')).toHaveCount(ARCHIVED);
            expect(await overflows(), 'archive tab').toBe(false);

            const first = page.locator('#subs-body tr').first();
            const shownCells = () =>
                first.locator('td').evaluateAll((tds) => tds.filter((td) => getComputedStyle(td).display !== 'none').length);
            if (width <= 760) {
                // Compact card: the summary cell and one icon button, about a quarter of the old card
                expect(await shownCells()).toBe(2);
                await expect(first.locator('.cell-compact .compact-meta')).toBeVisible();
                expect((await first.boundingBox()).height).toBeLessThan(90);
            } else {
                // Still a table: User, Series, Status, Actions — no blank Mode or Next Episode column
                expect(await shownCells()).toBe(4);
            }
        });
    });
}
