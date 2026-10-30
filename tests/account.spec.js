// Signing in to the panel and the user's own chats in it, on the API mock (tests/mock-account.js)
const { test, expect } = require('@playwright/test');
const { watchConsole, isNarrow } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// A 401 is the answer the panel expects before sign-in: the browser logs it as a failed load, and the
// refresh that met it logs its error
watchConsole({ ignore: /status of 401|Sign in: \/login in the bot/ });

/** One of the user's sections: the rail on a wide screen, the tab bar (a user) or More (an admin) */
async function openMine(page, section, { admin = false } = {}) {
    if (!isNarrow(page)) return page.locator(`.nav-item[data-section="${section}"]`).click();
    if (!admin) return page.locator(`.tab-item[data-section="${section}"]`).click();
    // An admin's phone: one "My account" row in More, then the switch at the top of the section
    await page.locator('.tab-item[data-open="more-modal"]').click();
    await page.locator('#more-modal .action-row[data-section="my-subs"]').click();
    if (section !== 'my-subs') await page.locator(`#my-subs-section .mine-switch [data-section="${section}"]`).click();
}

test('without a session the sign-in screen covers the panel; the Telegram button is a link to the bot', async ({
    page
}) => {
    const panel = await mockPanel(page, { signedOut: true });
    const gate = page.locator('#login-gate');
    await expect(gate).toBeVisible();
    await expect(page.locator('#login-tg')).toHaveAttribute('href', 'https://t.me/notfckbot?start=Lcode');
    await expect(gate).toContainText('/login');
    // One code for the one screen, and no "session ended" on a first visit
    await expect(page.locator('#login-tg')).toHaveAttribute('href', /t\.me/);
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(1);
    await expect(page.locator('#login-error')).toBeHidden();
    // Nothing of the panel can be reached under it
    const hit = await page.evaluate(() => {
        const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return Boolean(el && el.closest('#login-gate'));
    });
    expect(hit).toBe(true);
});

test('"Sign in with Telegram": the page waits for the answer in the bot, then opens the panel', async ({
    page,
    context
}) => {
    const panel = await mockPanel(page, { signedOut: true });
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    await expect(page.locator('#login-wait')).toBeVisible();
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
    const poll = panel.account.sent.find((r) => r.path === '/api/login/telegram/poll');
    expect(poll.body).toEqual({ code: 'c'.repeat(32), secret: 's'.repeat(43) });
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
});

test('the link from /login signs in only after a press and opens the chat it came from', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true, role: 'user', path: '/login/good-token' });
    // Opening the link spends nothing: a link preview only GETs
    expect(panel.account.sent.filter((r) => r.path === '/api/login')).toEqual([]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.find((r) => r.path === '/api/login').body).toEqual({ token: 'good-token' });
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('#my-subs-section')).toHaveClass(/active/);
    await expect(page.locator('#my-subs-section select[data-mine="chat"]')).toHaveValue('-100');
});

test('a used link says so and offers the other ways in', async ({ page }) => {
    await mockPanel(page, { signedOut: true, path: '/login/old-token' });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#login-error')).toContainText('This link has expired');
    await expect(page.locator('#login-tg')).toBeVisible();
});

test('a user sees only their own sections, and the panel asks for nothing else', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-subs-section')).toHaveClass(/active/);
    const nav = isNarrow(page) ? '.tabbar .tab-item' : '.rail-nav .nav-item';
    const visible = await page
        .locator(nav)
        .evaluateAll((items) =>
            items.filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.dataset.section)
        );
    expect(visible).toEqual(['my-subs', 'my-calendar', 'my-settings']);
    await expect(page.locator('#my-subs-body .mine-row')).toHaveCount(2);
    // No admin request was made for a user (they would all be refused)
    expect(panel.account.sent.every((r) => r.path.startsWith('/api/account/'))).toBe(true);
});

test('an admin has the whole panel and their own chats too', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    await openMine(page, 'my-calendar', { admin: true });
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    await expect(page.locator('.mine-cal-row')).toHaveCount(3);
});

test("on an admin's phone the switch between the three sections is as wide as the tabs under it", async ({
    page,
    isMobile
}) => {
    test.skip(!isMobile, 'phone layout');
    await mockPanel(page);
    await openMine(page, 'my-calendar', { admin: true });
    const widths = await page.evaluate(() =>
        ['.mine-switch', '#my-calendar-body .tab-filters'].map(
            (s) => document.querySelector(`#my-calendar-section ${s}`).getBoundingClientRect().width
        )
    );
    expect(widths[0]).toBeGreaterThan(0);
    expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
});

test('subscriptions: running series, films and finished ones in their tabs', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    const rows = page.locator('#my-subs-body .mine-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Одни из нас');
    await expect(rows.first()).toContainText('S2E5');
    await expect(rows.first().locator('.mine-chip')).toHaveText('Every episode');
    await page.locator('[data-action="mine-subs-tab"][data-tab="films"]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Дюна');
    await page.locator('[data-action="mine-subs-tab"][data-tab="archive"]').click();
    await expect(rows.first()).toContainText('Тед Лассо');
});

test('a series card changes the mode and unsubscribes after a confirmation', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await page.locator('#my-subs-body .mine-row', { hasText: 'Одни из нас' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card).toBeVisible();
    await card.getByLabel('When the whole season is out').check();
    await expect(page.locator('.toast').last()).toHaveText('Notifications changed');
    expect(
        panel.account.sent.find((r) => r.method === 'POST' && r.path === '/api/account/chats/42/series').body
    ).toEqual({ tmdbId: 'tv_100', mode: 'season' });
    await card.getByRole('button', { name: 'Unsubscribe' }).click();
    await card.getByRole('button', { name: 'Yes, unsubscribe' }).click();
    await expect(card).toBeHidden();
    await expect(page.locator('#my-subs-body .mine-row')).toHaveCount(1);
});

test('a card closes with the cross in its corner; its buttons are one height; Kinopoisk has its logo', async ({
    page
}) => {
    await mockPanel(page, { role: 'user' });
    await page.locator('#my-subs-body .mine-row', { hasText: 'Одни из нас' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Close', exact: true })).toHaveClass(/modal-x/);
    await expect(card.locator('.modal-actions')).toHaveCount(0);
    const kp = card.getByRole('link', { name: 'Kinopoisk' });
    await expect(kp.locator('.kp-logo use')).toHaveAttribute('href', '#kp-logo-symbol');
    const heights = await card
        .locator('.mine-links .btn, [data-action="mine-ask-unsubscribe"]')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights).toHaveLength(2);
    // The dialog may still be scaling in: equal up to a fraction of a pixel
    expect(Math.abs(heights[0] - heights[1])).toBeLessThan(0.5);
    const box = await card.locator('.modal-x').boundingBox();
    const content = await card.locator('.modal-content').boundingBox();
    expect(box.y - content.y).toBeLessThan(20);
    expect(content.x + content.width - (box.x + box.width)).toBeLessThan(20);
    await card.locator('.modal-x').click();
    await expect(card).toBeHidden();
});

test('search: a series asks for the mode, a film is added at once, what is on the list is marked', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.locator('#mine-q').fill('дюна');
    await page.locator('#mine-q').press('Enter');
    const results = page.locator('#mine-results .mine-row');
    await expect(results).toHaveCount(3);
    await expect(results.nth(1).locator('.mine-chip')).toHaveText('Added');

    await results.nth(0).getByRole('button', { name: 'Subscribe' }).click();
    await page.locator('#mine-card-modal').getByLabel('Episode 1 and the whole season').check();
    await page.locator('#mine-card-modal').getByRole('button', { name: 'Subscribe' }).click();
    await expect(results.nth(0).locator('.mine-chip')).toHaveText('Added');
    expect(panel.account.sent.find((r) => r.path === '/api/account/chats/42/series').body).toEqual({
        tmdbId: 'tv_500',
        mode: 'first_and_full'
    });

    await results.nth(2).getByRole('button', { name: 'Add' }).click();
    await expect(results.nth(2).locator('.mine-chip')).toHaveText('Added');
    expect(panel.account.sent.find((r) => r.path === '/api/account/chats/42/films').body).toEqual({
        tmdbId: 'movie_8'
    });
});

test('calendar: one list by month, series and films in their tabs, with posters; no period switch', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    const rows = body.locator('.mine-cal-row');
    await expect(rows).toHaveCount(3);
    await expect(body.locator('.mine-cal-month h3')).toHaveText(['October', 'November', 'January 2027']);
    await expect(rows.first()).toHaveClass(/past/);
    await expect(rows.nth(1)).toContainText('Одни из нас');
    await expect(rows.nth(1)).toContainText('S2E5 · Feel Her Love · season finale');
    await expect(rows.nth(1).locator('.mine-cal-when')).toHaveText('Today');
    await expect(rows.nth(1).locator('img.mine-poster')).toHaveAttribute('src', '/api/poster/w185/p1.jpg');
    // Only the Series / Films tabs: no week, month or year, no paging
    await expect(body.locator('.tab-filters')).toHaveCount(1);
    await expect(body.getByRole('button', { name: /^(Week|Month|Year|Earlier|Later)$/ })).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.path.includes('/calendar?'))).toBe(false);
    // Films have their own tab
    await body.getByRole('button', { name: 'Films' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Дюна: Часть третья');
    await expect(rows.first().locator('.mine-cal-when')).toHaveText('In 2 days');
});

test('calendar: an episode opens its card with Kinopoisk, not Kinopoisk itself', async ({
    page
}) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const card = page.locator('#mine-card-modal');
    await page.locator('#my-calendar-body .mine-cal-row').nth(1).click();
    await expect(card).toBeVisible();
    await expect(card.locator('h3')).toHaveText('Одни из нас');
    await expect(card).toContainText('S2E5 · Feel Her Love');
    await expect(card).toContainText('Season finale');
    await expect(card).toContainText('Ellie and Dina head out.');
    await expect(card.getByRole('link', { name: 'Kinopoisk' })).toHaveAttribute(
        'href',
        'https://www.kinopoisk.ru/series/1/'
    );
    await expect(card.getByRole('button', { name: /series card/i })).toHaveCount(0);
});

test("a group's settings: a member sees them, unchangeable; an admin's change is saved", async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    await page.locator('#my-settings-section select[data-mine="chat"]').selectOption('-100');
    await expect(page.locator('.mine-note')).toContainText("Only the group's admins");
    await expect(page.locator('#my-settings-body .custom-select-trigger').first()).toBeDisabled();
    await expect(page.locator('select[name="buttons_mode"]')).toHaveCount(1);
    await expect(page.locator('[data-action="mine-toggle"]').first()).toBeDisabled();

    panel.account.chats[1].settings = true;
    await openMine(page, 'my-subs');
    await openMine(page, 'my-settings');
    await page.locator('[data-action="mine-toggle"][data-name="digest_month"]').click();
    await expect(page.locator('.toast').last()).toHaveText('Saved');
    expect(panel.account.sent.find((r) => r.method === 'PATCH').body).toEqual({ digest_month: true });
});

test('signing out, or a session that ends, brings back the sign-in screen', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-subs-body .mine-row')).toHaveCount(2);
    panel.account.signedIn = false;
    await openMine(page, 'my-calendar');
    await expect(page.locator('#login-gate')).toBeVisible();
    await expect(page.locator('#login-error')).toContainText('Your session has ended');
});

test('on a phone a user has three tabs, big enough to tap, and nothing scrolls sideways', async ({
    page,
    isMobile
}) => {
    test.skip(!isMobile, 'phone layout');
    await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-subs-body .mine-row')).toHaveCount(2);
    const layout = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.tabbar .tab-item')].filter(
            (el) => el.getBoundingClientRect().width > 0
        );
        return {
            tabs: tabs.length,
            tabHeight: Math.min(...tabs.map((t) => t.getBoundingClientRect().height)),
            overflow: document.documentElement.scrollWidth - window.innerWidth
        };
    });
    expect(layout.tabs).toBe(3);
    expect(layout.tabHeight).toBeGreaterThanOrEqual(44);
    expect(layout.overflow).toBeLessThanOrEqual(0);
});

test('signing out works on a phone too: from More for an admin, from the settings page for a user', async ({
    page,
    isMobile
}) => {
    test.skip(!isMobile, 'phone layout');
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#login-gate')).toBeVisible();
    expect(panel.account.sent.some((r) => r.path === '/api/logout')).toBe(true);
});
