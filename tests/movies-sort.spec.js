const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * Sorting the Movies section (the watchlist) by year and release date. Runs on
 * the canned API from mock-panel.js: five waiting films, one without a date.
 */

async function goToMovies(page) {
    const narrow = page.viewportSize().width <= 1024;
    await page.locator(`${narrow ? '.tab-item' : '.nav-item'}[data-section="watchlist"]`).click();
    await expect(page.locator('#watchlist-section')).toHaveClass(/active/);
    await expect(page.locator('#watchlist-body .skeleton-row')).toHaveCount(0, { timeout: 15_000 });
}

const titles = (page) => page.locator('#watchlist-body [data-label="Film Title"]').allInnerTexts();

// Column headers on wide screens; the header row is hidden on phones, where a Sort strip stands in
function sortButton(page, key) {
    const narrow = page.viewportSize().width <= 760;
    return page.locator(`${narrow ? '.sort-bar' : 'thead'} [data-action="sort"][data-sort="${key}"]`);
}

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await mockPanel(page);
    await expect(page.locator('#chats-count')).not.toHaveText('-');
    page.__errors = errors;
    await goToMovies(page);
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'console should stay clean').toEqual([]);
});

test('the section is called Movies and keeps the API order until asked', async ({ page }) => {
    await expect(page.locator('#watchlist-section h1')).toHaveText('Movies');
    expect(await titles(page)).toEqual([
        'Dune: Part Three',
        'Avengers: Doomsday',
        'No Date Yet',
        'Spider-Man 4',
        'Hunger Games'
    ]);
});

test('Release sorts ascending, then descending, then back; undated films stay last', async ({ page }) => {
    const button = sortButton(page, 'release');

    await button.click();
    expect(await titles(page)).toEqual([
        'Hunger Games',
        'Avengers: Doomsday',
        'Dune: Part Three',
        'Spider-Man 4',
        'No Date Yet'
    ]);
    await expect(button).toHaveAttribute('data-dir', 'asc');
    await expect(button).toHaveAttribute('aria-label', 'Release, sorted ascending');

    await button.click();
    expect(await titles(page)).toEqual([
        'Spider-Man 4',
        'Dune: Part Three',
        'Avengers: Doomsday',
        'Hunger Games',
        'No Date Yet'
    ]);
    await expect(button).toHaveAttribute('data-dir', 'desc');

    await button.click();
    expect((await titles(page))[0]).toBe('Dune: Part Three');
    await expect(button).toHaveAttribute('data-dir', '');
});

test('Year sorts by year, then by release date within it', async ({ page }) => {
    await sortButton(page, 'year').click();
    expect(await titles(page)).toEqual([
        'Hunger Games',
        'Avengers: Doomsday',
        'Dune: Part Three',
        'Spider-Man 4',
        'No Date Yet'
    ]);
});

test('the sort carries over to the Released tab', async ({ page }) => {
    await sortButton(page, 'year').click();
    await page.locator('.tab-filters [data-films-tab="archive"]').click();
    expect(await titles(page)).toEqual(['Dune']);
});

test('the header cell reports the order to assistive tech', async ({ page }) => {
    await sortButton(page, 'release').click();
    await expect(page.locator('thead th[aria-sort="ascending"]')).toHaveCount(1);
    await expect(page.locator('thead th[aria-sort="none"]')).toHaveCount(1);
});
