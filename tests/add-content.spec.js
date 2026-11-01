const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');
watchConsole({ ignore: /status of 409/ });

async function searchForAlice(page) {
    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await page.locator('#action-add').click();
    await page.locator('#content-search-input').fill('long title');
    await expect(page.locator('#content-search-results li')).toHaveCount(6);
}
const result = (page, index) => page.locator('#content-search-results .search-result-open').nth(index);
const card = (page) => page.locator('#content-card-modal');

test('admin and user search popups have the same dialog geometry and close button', async ({ page }) => {
    const measure = (selector) =>
        page.locator(selector).evaluate((el) => {
            const style = getComputedStyle(el);
            const actions = getComputedStyle(el.querySelector('.modal-actions'));
            return {
                width: style.width,
                padding: style.padding,
                gap: style.gap,
                actionsMargin: actions.marginTop,
                close: el.querySelector('.modal-x').innerHTML
            };
        });
    await mockPanel(page);
    await searchForAlice(page);
    await result(page, 2).click();
    const admin = await measure('#content-card-modal .modal-content');
    await mockPanel(page, { role: 'user' });
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.locator('#mine-q').fill('дюна');
    await page.locator('#mine-q').press('Enter');
    await page.locator('#mine-results .search-result-open').first().click();
    expect(await measure('#mine-card-modal .modal-content')).toEqual(admin);
});

test('regression: clicking a search title opens its card', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await page.locator('#action-add').click();
    await page.locator('#content-search-input').fill('long title');
    await page
        .locator('#content-search-results .result-title, #content-search-results .search-result-open')
        .first()
        .click();
    await expect(card(page)).toBeVisible();
});

test('a search title opens a card; cancelling preserves the query and results', async ({ page }) => {
    await mockPanel(page);
    await searchForAlice(page);
    await result(page, 0).click();
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('#content-card-title')).toContainText('film title');
    await expect(card(page).locator('.mine-overview')).toHaveText('A search description.');
    await expect(card(page).locator('.mine-modes')).toHaveCount(0);
    await card(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(card(page)).toBeHidden();
    await expect(page.locator('#content-search-input')).toHaveValue('long title');
    await expect(page.locator('#content-search-results li')).toHaveCount(6);
});

test('Escape from a preview returns to search, then back to the chat menu', async ({ page }) => {
    await mockPanel(page);
    await searchForAlice(page);
    await result(page, 0).click();
    await page.keyboard.press('Escape');
    await expect(card(page)).toBeHidden();
    await expect(page.locator('#chat-actions-modal')).toBeHidden();
    await expect(page.locator('#add-content-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#add-content-modal')).toBeHidden();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});

test('rows fit the dialog and the keyboard opens the series mode card', async ({ page }) => {
    const panel = await mockPanel(page);
    await searchForAlice(page);
    expect(await page.locator('#content-search-results').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await result(page, 2).focus();
    await page.keyboard.press('Enter');
    await expect(card(page).locator('#confirm-add-content')).toBeInViewport({ ratio: 1 });
    await card(page).getByLabel('Episode 1 and the whole season').check();
    await card(page).getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(card(page)).toBeHidden();
    await expect(page.locator('#content-search-results li').nth(2).locator('.mine-chip')).toHaveText('Added');
    expect(panel.lastAdd).toEqual({
        path: '/api/subscription',
        body: { chatId: '101', tmdbId: 903, notify_type: 'first_and_full' }
    });
    await result(page, 2).click();
    await expect(card(page).getByRole('button', { name: 'Added', exact: true })).toBeDisabled();
});

test('a film adds directly from results and leaves the search open', async ({ page }) => {
    const panel = await mockPanel(page);
    await searchForAlice(page);
    await page.locator('#content-search-results li').first().getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('#content-search-results li').first().locator('.mine-chip')).toHaveText('Added');
    await expect(card(page)).toBeHidden();
    await expect(page.locator('#add-content-modal')).toBeVisible();
    expect(panel.lastAdd).toMatchObject({ path: '/api/watchlist', body: { chatId: '101', tmdbId: 901 } });
});

test('a pending add cannot submit twice and an error keeps the card retryable', async ({ page }) => {
    let release;
    const addHold = new Promise((r) => (release = r));
    const panel = await mockPanel(page, { addHold, addError: 'Try again' });
    await searchForAlice(page);
    await result(page, 0).click();
    const button = card(page).locator('#confirm-add-content');
    await button.click();
    await expect(button).toHaveText('Adding…');
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    release();
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Add');
    await expect(card(page)).toBeVisible();
    expect(panel.added).toBe(1);
});

test('a card opened during a quick film add closes when that add succeeds', async ({ page }) => {
    let release;
    const addHold = new Promise((r) => (release = r));
    const panel = await mockPanel(page, { addHold });
    await searchForAlice(page);
    await page.locator('#content-search-results li').first().getByRole('button', { name: 'Add', exact: true }).click();
    await result(page, 0).click();
    await expect(card(page)).toBeVisible();
    release();
    await expect(card(page)).toBeHidden();
    await expect(page.locator('#content-search-results li').first().locator('.mine-chip')).toHaveText('Added');
    expect(panel.added).toBe(1);
});

test('existing subscriptions and waiting films are marked before any add', async ({ page }) => {
    await mockPanel(page);
    await page.route('**/api/data/subs', (route) => route.fulfill({ json: [{ chatId: 101, seriesId: 'tv_903' }] }));
    await page.route('**/api/data/films', (route) =>
        route.fulfill({
            json: [
                { chatId: 101, tmdb_id: 'movie_901', notified: false },
                { chatId: 101, tmdb_id: 'movie_902', notified: true }
            ]
        })
    );
    await searchForAlice(page);
    await expect(page.locator('#content-search-results .mine-chip')).toHaveCount(2);
    await expect(
        page.locator('#content-search-results li').nth(1).getByRole('button', { name: 'Add', exact: true })
    ).toBeVisible();
});

test('an old add cannot close a new card for another chat', async ({ page }) => {
    let release;
    const addHold = new Promise((r) => (release = r));
    await mockPanel(page, { addHold });
    await searchForAlice(page);
    await result(page, 0).click();
    await card(page).locator('#confirm-add-content').click();
    await card(page).locator('.modal-x').click();
    await page.locator('[data-close-return="add-content-modal"]').click();
    await page.keyboard.press('Escape');
    await page.locator('[data-action="chat-actions"][data-id="102"]').click();
    await page.locator('#action-add').click();
    await page.locator('#content-search-input').fill('long title');
    await expect(page.locator('#content-search-results li')).toHaveCount(6);
    await result(page, 2).click();
    release();
    await expect(page.locator('.toast', { hasText: 'The bot writes' })).toBeVisible();
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('#content-card-title')).toContainText('series title');
    await card(page).locator('.modal-x').click();
    await expect(page.locator('#content-search-results .mine-chip')).toHaveCount(0);
});

test('Serials filters results and requires the chat to be chosen explicitly', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'subs');
    await page.locator('#subs-section [data-action="add-content"]').click();
    await page.locator('#content-search-input').fill('long title');
    await expect(page.locator('#content-search-results li')).toHaveCount(2);
    await result(page, 0).click();
    await card(page).locator('#confirm-add-content').click();
    await expect(card(page)).toBeHidden();
    const trigger = page.locator('#content-chat-field .custom-select-trigger');
    await expect(trigger).toBeFocused();
    expect(panel.lastAdd).toBeUndefined();
    await trigger.click();
    await page.locator('.custom-select-option', { hasText: 'bob' }).click();
    await result(page, 0).click();
    await card(page).locator('#confirm-add-content').click();
    await expect(card(page)).toBeHidden();
    expect(panel.lastAdd.body).toMatchObject({ chatId: '102', tmdbId: 903 });
});

test('Movies filters films and Added belongs only to the selected chat', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSection(page, 'watchlist');
    await page.locator('#watchlist-section [data-action="add-content"]').click();
    const trigger = page.locator('#content-chat-field .custom-select-trigger');
    await trigger.click();
    await page.locator('.custom-select-option', { hasText: 'alice' }).click();
    await page.locator('#content-search-input').fill('long title');
    await expect(page.locator('#content-search-results li')).toHaveCount(4);
    await page.locator('#content-search-results li').first().getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('#content-search-results .mine-chip')).toHaveCount(1);
    await trigger.click();
    await page.locator('.custom-select-option', { hasText: 'bob' }).click();
    await expect(page.locator('#content-search-results .mine-chip')).toHaveCount(0);
    expect(panel.lastAdd.body.chatId).toBe('101');
});

for (const reopen of [false, true])
    test(`late search cannot fill ${reopen ? 'a reopened dialog' : 'a cleared query'}`, async ({ page }) => {
        await mockPanel(page);
        let release;
        const held = new Promise((r) => (release = r));
        await page.route('**/api/tmdb/search*', async (route) => {
            await held;
            await route.fallback();
        });
        await openSection(page, 'subs');
        await page.locator('#subs-section [data-action="add-content"]').click();
        const requested = page.waitForRequest('**/api/tmdb/search*');
        await page.locator('#content-search-input').fill('long title');
        await requested;
        if (reopen) {
            await page.locator('[data-close-return="add-content-modal"]').click();
            await openSection(page, 'watchlist');
            await page.locator('#watchlist-section [data-action="add-content"]').click();
        } else {
            await page.locator('#content-search-input').fill('');
            await page.waitForTimeout(600);
        }
        const response = page.waitForResponse('**/api/tmdb/search*');
        release();
        await response;
        await expect(page.locator('#content-search-results')).toBeEmpty();
    });
