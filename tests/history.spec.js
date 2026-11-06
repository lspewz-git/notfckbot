const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/** History: what came out in a year, serials and movies apart, on the canned API. */

watchConsole();

/** The rail on a wide screen; on a phone, More → History. */
async function openHistory(page) {
    await openSection(page, 'history');
    await expect(page.locator('#history-section')).toHaveClass(/active/);
}

test('the latest year: series (with their seasons) and films in two lists, with genres; Kinopoisk is in the card', async ({
    page
}) => {
    await mockPanel(page);
    await openHistory(page);

    await expect(page.locator('#history-years .cat-chip')).toHaveText(['2026', '2025']);
    await expect(page.locator('#history-years .cat-chip.active')).toHaveText('2026');
    await expect(page.locator('#history-years .cat-chip.active')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#history-series-count')).toHaveText(' · 2');
    await expect(page.locator('#history-films-count')).toHaveText(' · 1');
    await expect(page.locator('.history-title')).toHaveText(['Series · 2', 'Films · 1']);

    const first = page.locator('#history-series .history-item').first();
    await expect(first.locator('.row-name')).toHaveText('Stranger Things');
    await expect(first.locator('.history-genres')).toHaveText('Seasons 4, 5 · drama, mystery');
    await expect(page.locator('#history-series .history-genres').nth(1)).toHaveText('Season 2');
    await expect(page.locator('#history-films .history-genres')).toHaveText('sci-fi');
    await expect(page.locator('#history-section .kp-link')).toHaveCount(0);
    await expect(page.locator('#history-films .row-name')).toHaveText(['Dune: Part Three']);
});

test('another year; an empty list says so', async ({ page }) => {
    await mockPanel(page);
    await openHistory(page);
    await page.locator('#history-years .cat-chip', { hasText: '2025' }).click();
    await expect(page.locator('#history-years .cat-chip.active')).toHaveText('2025');
    await expect(page.locator('#history-series .row-name')).toHaveText(['Game of Thrones']);
    await expect(page.locator('#history-films .history-empty')).toHaveText('No movie came out in 2025.');
    await expect(page.locator('#history-films-count')).toHaveText(' · 0');
});

test('a title opens its card, with Kinopoisk and its logo', async ({ page }) => {
    await mockPanel(page);
    await openHistory(page);
    await page.locator('#history-series .history-open', { hasText: 'Stranger Things' }).click();
    await expect(page.locator('#released-title')).toHaveText('Stranger Things');
    const kp = page.locator('#released-modal .tc-link');
    await expect(kp).toHaveAttribute('href', 'https://www.kinopoisk.ru/series/915196/');
    await expect(kp).toHaveAttribute('target', '_blank');
    expect(await kp.locator('.kp-logo').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(10);
});

test('a long list comes in pages of 10, with the size remembered; a short one has no pager', async ({ page }) => {
    const serial = (i) => ({
        tmdbId: `tv_${i}`,
        title: `Serial ${String(i).padStart(2, '0')}`,
        genres: [],
        kinopoiskUrl: `https://www.kinopoisk.ru/series/${i}/`
    });
    const history = () => ({
        years: [2026],
        year: 2026,
        series: Array.from({ length: 23 }, (_, i) => serial(i + 1)),
        films: []
    });
    await mockPanel(page, { history });
    await openHistory(page);

    const list = page.locator('#history-series .history-item:not(.history-filler)');
    const card = page.locator('.history-group:has(#history-series)');
    const pager = page.locator('#history-series-pager');
    await expect(list).toHaveCount(10);
    await expect(pager.locator('.pager-info')).toHaveText('1–10 of 23');
    await expect(pager.locator('[data-step="-1"]')).toBeDisabled();
    const fullHeight = (await card.boundingBox()).height;

    await pager.locator('[data-step="1"]').click();
    await pager.locator('[data-step="1"]').click();
    await expect(pager.locator('.pager-info')).toHaveText('21–23 of 23');
    await expect(list).toHaveCount(3);
    await expect(pager.locator('[data-step="1"]')).toBeDisabled();
    // The short last page keeps the card as tall as a full one
    expect((await card.boundingBox()).height).toBe(fullHeight);
    // The movies list is empty: no pager there
    await expect(page.locator('#history-films-pager')).toBeHidden();

    // 25 a page: all on one, and still so after a reload
    await page.locator('.custom-select:has([data-history-size="series"]) .custom-select-trigger').click();
    await page.locator('.custom-select-option', { hasText: '25' }).click();
    await expect(list).toHaveCount(23);
    await page.reload();
    await openHistory(page);
    await expect(page.locator('#history-series .history-item:not(.history-filler)')).toHaveCount(23);
});

/** One serial per year, named after it, so the list shows which year's answer was drawn. */
const yearData = (year) => ({
    years: [2026, 2025],
    year: year === 2025 ? 2025 : 2026,
    series: [
        {
            tmdbId: `tv_${year}`,
            title: `Serial of ${year === 2025 ? 2025 : 2026}`,
            genres: [],
            kinopoiskUrl: 'https://www.kinopoisk.ru/series/1/'
        }
    ],
    films: []
});

test('a slow answer for a year left behind does not replace the year pressed after it', async ({ page }) => {
    await mockPanel(page, {
        history: async (year) => {
            if (year === 2025) await new Promise((resolve) => setTimeout(resolve, 1500));
            return yearData(year);
        }
    });
    await openHistory(page);
    await expect(page.locator('#history-series .row-name')).toHaveText('Serial of 2026');

    await page.locator('#history-years .cat-chip', { hasText: '2025' }).click();
    await page.locator('#history-years .cat-chip', { hasText: '2026' }).click();
    // Past the moment the 2025 answer arrives
    await page.waitForTimeout(2000);
    await expect(page.locator('#history-years .cat-chip.active')).toHaveText('2026');
    await expect(page.locator('#history-series .row-name')).toHaveText('Serial of 2026');
});

test('a year that fails to load says so and keeps the year on screen; pressing it again retries', async ({ page }) => {
    let failures = 1;
    await mockPanel(page, {
        history: (year) => {
            if (year === 2025 && failures-- > 0) return { status: 500, body: { error: 'Database is down' } };
            return yearData(year);
        }
    });
    await openHistory(page);
    const year2025 = page.locator('#history-years .cat-chip', { hasText: '2025' });

    await year2025.click();
    await expect(page.locator('.toast-error')).toContainText("Couldn't load 2025");
    await expect(page.locator('#history-years .cat-chip.active')).toHaveText('2026');
    await expect(page.locator('#history-series .row-name')).toHaveText('Serial of 2026');

    await year2025.click();
    await expect(page.locator('#history-years .cat-chip.active')).toHaveText('2025');
    await expect(page.locator('#history-series .row-name')).toHaveText('Serial of 2025');
    // The browser reports the failed request itself; nothing else may be logged
    page.__errors = page.__errors.filter((e) => !e.includes('500'));
});

test('a whole row is the title button and opens from the keyboard', async ({ page }) => {
    await mockPanel(page);
    await openHistory(page);
    const row = page.locator('#history-series .history-open').first();
    expect(await row.evaluate((el) => el.tagName)).toBe('BUTTON');
    expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#released-title')).toHaveText('Stranger Things');
});

