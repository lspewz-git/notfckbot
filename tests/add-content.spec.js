const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * Adding a series or film to a chat from the panel, on the canned API: the results list
 * scrolls only downwards, and the add button shows it is working until the server answers.
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

/** Chats → alice's actions → Add, then a search that finds six long-titled results. */
async function searchForAlice(page) {
    const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
    await page.locator(`${narrow ? '.tab-item' : '.nav-item'}[data-section="chats"]`).click();
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await page.locator('#action-add').click();
    await page.locator('#content-search-input').fill('long title');
    await expect(page.locator('#content-search-results [data-action="select-content"]')).toHaveCount(6);
}

test('search results scroll down only, never sideways', async ({ page }) => {
    await mockPanel(page);
    await searchForAlice(page);
    const box = page.locator('#content-search-results');
    const { scrollWidth, clientWidth } = await box.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test('the add button shows it is working, and a second click does not add twice', async ({ page }) => {
    let release;
    const addHold = new Promise((r) => (release = r));
    const panel = await mockPanel(page, { addHold });
    await searchForAlice(page);

    // The first result is a film
    await page.locator('#content-search-results [data-index="0"]').click();
    const add = page.locator('#confirm-add-content');
    await expect(add).toHaveText('Add to Watchlist');

    await add.click();
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute('aria-busy', 'true');
    await expect(add).toHaveText('Adding…');
    await add.click({ force: true });

    release();
    await expect(page.locator('.toast')).toContainText('Фильм добавлен в список ожидания');
    await expect(page.locator('#add-content-modal')).toBeHidden();
    expect(panel.added).toBe(1);
});

test('picking another result during an add leaves the button labelled for the new pick', async ({ page }) => {
    let release;
    const addHold = new Promise((r) => (release = r));
    await mockPanel(page, { addHold, addError: 'Film already in watchlist for this chat' });
    await searchForAlice(page);

    await page.locator('#content-search-results [data-index="0"]').click(); // a film
    const add = page.locator('#confirm-add-content');
    await add.click();
    await expect(add).toHaveText('Adding…');
    await page.locator('#content-search-results [data-index="2"]').click(); // a series
    await expect(add).toHaveText('Adding…');

    release();
    await expect(page.locator('.toast')).toContainText('Film already in watchlist');
    await expect(add).toHaveText('Add Subscription');
    await expect(add).toBeEnabled();
    // The browser reports the refused add itself; that one is expected here
    page.__errors = page.__errors.filter((e) => !/status of 409/.test(e));
});

test('an add that ends after the dialog was reopened for another chat leaves that dialog open', async ({ page }) => {
    let release;
    const addHold = new Promise((r) => (release = r));
    await mockPanel(page, { addHold });
    await searchForAlice(page);
    await page.locator('#content-search-results [data-index="0"]').click();
    await page.locator('#confirm-add-content').click();

    // Cancel goes back to alice's menu; close it and open bob's dialog instead
    await page.locator('[data-close-return="add-content-modal"]').click();
    await page.keyboard.press('Escape');
    await page.locator('[data-action="chat-actions"][data-id="102"]').click();
    await page.locator('#action-add').click();
    await expect(page.locator('#add-content-target')).toHaveText('bob');

    release();
    await expect(page.locator('.toast')).toContainText('Фильм добавлен в список ожидания');
    await expect(page.locator('#add-content-modal')).toBeVisible();
    await expect(page.locator('#add-content-target')).toHaveText('bob');
});
