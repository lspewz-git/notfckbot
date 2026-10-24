const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Adding a series or film to a chat from the panel, on the canned API: the results list
 * scrolls only downwards, and the add button shows it is working until the server answers.
 */

watchConsole();

/** Chats → alice's actions → Add, then a search that finds six long-titled results. */
async function searchForAlice(page) {
    await openSection(page, 'chats');
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

test('Serials adds a series for a chat picked in the dialog, searching series only', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'subs');
    await page.locator('#subs-section [data-action="add-content"]').click();

    const dialog = page.locator('#add-content-modal');
    await expect(dialog.locator('#add-content-modal-title')).toHaveText('Add serial');
    await expect(dialog.locator('#content-chat-field')).toBeVisible();
    await expect(dialog.locator('#content-search-input')).toHaveAttribute('placeholder', 'Search serials...');

    // The styled dropdown: open it and pick bob
    await dialog.locator('#content-chat-field .custom-select-trigger').click();
    await page.locator('.custom-select-option', { hasText: 'bob' }).click();
    await expect(dialog.locator('#content-chat-field .custom-select-trigger')).toHaveText('bob (private)');

    await dialog.locator('#content-search-input').fill('long title');
    const results = dialog.locator('#content-search-results [data-action="select-content"]');
    // Six results come back, two of them series; the films are left out
    await expect(results).toHaveCount(2);
    await expect(results.filter({ hasText: 'Movie' })).toHaveCount(0);

    await results.first().click();
    await dialog.locator('#confirm-add-content').click();
    await expect(page.locator('.toast')).toContainText('Подписка добавлена');
    expect(panel.lastAdd.path).toBe('/api/subscription');
    expect(panel.lastAdd.body).toMatchObject({ chatId: '102', tmdbId: 903 });
});

test('Movies adds a film, searching films only, once a chat is chosen', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'watchlist');
    await page.locator('#watchlist-section [data-action="add-content"]').click();

    const dialog = page.locator('#add-content-modal');
    await expect(dialog.locator('#add-content-modal-title')).toHaveText('Add movie');
    await dialog.locator('#content-search-input').fill('long title');
    const results = dialog.locator('#content-search-results [data-action="select-content"]');
    await expect(results).toHaveCount(4);
    await expect(results.filter({ hasText: 'Series' })).toHaveCount(0);

    await results.first().click();

    // No chat is preselected: adding asks for one and sends nothing
    const trigger = dialog.locator('#content-chat-field .custom-select-trigger');
    await expect(trigger).toHaveText('Choose a chat…');
    await dialog.locator('#confirm-add-content').click();
    await expect(page.locator('.toast')).toContainText('Choose a chat first');
    await expect(trigger).toBeFocused();
    expect(panel.lastAdd).toBeUndefined();

    await trigger.click();
    await page.locator('.custom-select-option', { hasText: 'alice' }).click();
    await dialog.locator('#confirm-add-content').click();
    // The "Choose a chat first" toast may still be up
    await expect(page.locator('.toast', { hasText: 'Фильм добавлен в список ожидания' })).toBeVisible();
    expect(panel.lastAdd).toMatchObject({ path: '/api/watchlist', body: { chatId: '101', tmdbId: 901 } });
});

test("a chat's own Add has no chat picker and searches both kinds", async ({ page }) => {
    await mockPanel(page);
    // Opened from Serials first, so a leftover picker or filter would show here
    await openSection(page, 'subs');
    await page.locator('#subs-section [data-action="add-content"]').click();
    await page.locator('[data-close-return="add-content-modal"]').click();

    await searchForAlice(page);
    await expect(page.locator('#add-content-modal-title')).toHaveText('Add for alice');
    await expect(page.locator('#content-chat-field')).toBeHidden();
});

test('a search answer that arrives after the dialog was reopened does not fill it', async ({ page }) => {
    await mockPanel(page);
    // Hold the first search until the dialog has been closed and reopened from Movies
    let release;
    const held = new Promise((r) => (release = r));
    let first = true;
    await page.route('**/api/tmdb/search*', async (route) => {
        if (first) {
            first = false;
            await held;
        }
        await route.fallback();
    });

    await openSection(page, 'subs');
    await page.locator('#subs-section [data-action="add-content"]').click();
    await page.locator('#content-search-input').fill('long title');
    await page.waitForTimeout(700); // past the search's debounce, so the held request is out
    await page.locator('[data-close-return="add-content-modal"]').click();

    await openSection(page, 'watchlist');
    await page.locator('#watchlist-section [data-action="add-content"]').click();
    release();
    await page.waitForTimeout(500);
    await expect(page.locator('#content-search-results [data-action="select-content"]')).toHaveCount(0);
});

test('after picking a result the Add button is in view without scrolling, and × closes the dialog', async ({
    page
}) => {
    await mockPanel(page);
    await openSection(page, 'watchlist');
    await page.locator('#watchlist-section [data-action="add-content"]').click();
    await page.locator('#content-search-input').fill('long title');
    await page.locator('#content-search-results [data-index="0"]').click();

    // Six results would push it below the fold on a phone if the dialog scrolled as a whole
    await expect(page.locator('#confirm-add-content')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('#add-content-modal button', { hasText: 'Cancel' })).toHaveCount(0);

    await page.locator('#add-content-modal .modal-x').click();
    await expect(page.locator('#add-content-modal')).toBeHidden();
});

test('on a phone held sideways the dialog scrolls, so the Add button can still be reached', async ({
    page,
    isMobile
}) => {
    // The size is set here, so the desktop project would only repeat the phone's run
    test.skip(!isMobile, 'run once, on the touch device');
    await page.setViewportSize({ width: 812, height: 375 });
    await mockPanel(page);
    await openSection(page, 'subs');
    await page.locator('#subs-section [data-action="add-content"]').click();
    await page.locator('#content-search-input').fill('long title');
    // A series: its notification mode makes the picked block taller
    await page.locator('#content-search-results [data-index="0"]').click();

    const dialog = page.locator('#add-content-modal .modal-content');
    // Taller than the screen, so it has to scroll: scrollIntoView would work even on a clipped
    // box, so check what a user can do instead
    const { overflowY, overflows } = await dialog.evaluate((el) => ({
        overflowY: getComputedStyle(el).overflowY,
        overflows: el.scrollHeight > el.clientHeight
    }));
    expect(overflows).toBe(true);
    expect(overflowY).toBe('auto');
    if (test.info().project.name === 'desktop') {
        // A wheel over the dialog brings the button up (mobile WebKit has no wheel)
        const box = await dialog.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 40);
        await page.mouse.wheel(0, 600);
        await expect(page.locator('#confirm-add-content')).toBeInViewport({ ratio: 1 });
    }
});
