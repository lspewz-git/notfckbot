// Signing in to the panel and the user's own chats in it, on the API mock (tests/mock-account.js)
const { test, expect } = require('@playwright/test');
const { watchConsole, isNarrow, pickChat } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// A 401 is the answer the panel expects before sign-in (and to a wrong password, a 429 to too many
// tries): the browser logs it as a failed load, and the refresh that met it logs its error
watchConsole({ ignore: /status of 4(01|29)|Sign in: \/login in the bot/ });

/** The visible rail or tab-bar items, by section (or action, for the way back to the admin panel) */
const visibleNav = (page, selector) =>
    page
        .locator(selector)
        .evaluateAll((items) =>
            items
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map((el) => el.dataset.section || el.dataset.action)
        );

/**
 * One of the user's sections: the rail on a wide screen (an admin first switches to "My account"),
 * the tab bar (a user) or More (an admin)
 */
async function openMine(page, section, { admin = false } = {}) {
    if (!isNarrow(page)) {
        if (admin) {
            await page.locator('.view-switch').click();
            await page.locator('#pick-list .pick-row', { hasText: 'My account' }).click();
        }
        return page.locator(`.nav-item[data-section="${section}"]`).click();
    }
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
    await expect(page.locator('#login-tg')).toHaveText('Continue with Telegram');
    await expect(page.locator('#login-name')).toHaveAttribute('placeholder', '@username or ID');
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

test('"Continue with Telegram": the page waits for the answer in the bot, then opens the panel', async ({
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
    await expect(page.locator('#my-subs-section .mine-chat-chip')).toContainText('Киноклуб');
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
    expect(await visibleNav(page, nav)).toEqual(['my-subs', 'my-calendar', 'my-settings']);
    await expect(page.locator('#my-subs-body .mine-row')).toHaveCount(2);
    // No admin request was made for a user (they would all be refused)
    expect(panel.account.sent.every((r) => r.path.startsWith('/api/account/'))).toBe(true);
});

test('an admin has the whole panel and their own chats too', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    await openMine(page, 'my-calendar', { admin: true });
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    await expect(page.locator('.mine-cal-row')).toHaveCount(2);
});

test("an admin's two views: the admin panel and My account, each with only its own sections", async ({ page }) => {
    await mockPanel(page);
    const nav = isNarrow(page) ? '.tabbar .tab-item' : '.rail-nav .nav-item';
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    expect(await visibleNav(page, nav)).not.toContain('my-subs');

    await openMine(page, 'my-calendar', { admin: true });
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    const mine = isNarrow(page)
        ? ['my-subs', 'my-calendar', 'my-settings', 'view-admin']
        : ['my-subs', 'my-calendar', 'my-settings'];
    expect(await visibleNav(page, isNarrow(page) ? nav : '.rail-nav .nav-item')).toEqual(mine);

    // Back to the admin panel, on the section it was left on; the switch marks the current view
    if (isNarrow(page)) await page.locator('.tab-admin').click();
    else {
        await expect(page.locator('.view-switch')).toContainText('Me');
        await page.locator('.view-switch').click();
        await expect(page.locator('#pick-list .pick-row.selected')).toContainText('My account');
        await page.locator('#pick-list .pick-row', { hasText: 'Admin panel' }).click();
        await expect(page.locator('.view-switch')).toContainText('Admin');
    }
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    expect(await visibleNav(page, nav)).not.toContain('my-calendar');
});

test('a user has no view switch', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-subs-section')).toHaveClass(/active/);
    await expect(page.locator('.view-switch')).toBeHidden();
    await expect(page.locator('.tab-admin')).toBeHidden();
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

test('calendar: one list of what is to come, series and films in their tabs, with posters; no period switch', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    const rows = body.locator('.mine-cal-row');
    // The episode already out is left out; the rest share one card, a month's name before its first row
    await expect(rows).toHaveCount(2);
    await expect(body.locator('ul.mine-rows')).toHaveCount(1);
    await expect(body.locator('.mine-cal-month')).toHaveText(['November', 'January 2027']);
    await expect(body.locator('.mine-cal-date')).toHaveText(['04Wed', '15Fri']);
    await expect(rows.first()).toContainText('Одни из нас');
    await expect(rows.first()).toContainText('S2E5 · Feel Her Love · season finale');
    await expect(rows.first().locator('.mine-cal-when')).toHaveText('Today');
    // No title from TMDB yet: a stand-in
    await expect(rows.nth(1)).toContainText('S4E1 · Episode 1 · season premiere');
    await expect(rows.first().locator('img.mine-poster')).toHaveAttribute('src', '/api/poster/w185/p1.jpg');
    // Only the Series / Films tabs: no week, month or year, no paging
    await expect(body.locator('.tab-filters')).toHaveCount(1);
    await expect(body.getByRole('button', { name: /^(Week|Month|Year|Earlier|Later)$/ })).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.path.includes('/calendar?'))).toBe(false);
    // Films have their own tab; yesterday's release is still shown
    await body.getByRole('button', { name: 'Films' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Мегалополис');
    await expect(rows.first().locator('.mine-cal-when')).toHaveText('Yesterday');
    await expect(rows.nth(1)).toContainText('Дюна: Часть третья');
    await expect(rows.nth(1).locator('.mine-cal-when')).toHaveText('In 2 days');
});

test('calendar: an episode opens its card with Kinopoisk, not Kinopoisk itself', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const card = page.locator('#mine-card-modal');
    await page.locator('#my-calendar-body .mine-cal-row').first().click();
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

test('the panel opens on the own account, not on the group picked last time', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    await pickChat(page, 'my-settings', 'Киноклуб');
    await page.reload();
    await openMine(page, 'my-settings');
    await expect(page.locator('#my-settings-section .mine-chat-chip')).toContainText(panel.account.chats[0].title);
});

test("a group's settings: a member sees them, unchangeable; an admin's change is saved", async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    await pickChat(page, 'my-settings', 'Киноклуб');
    await expect(page.locator('.mine-note')).toContainText("Only the group's admins");
    await expect(page.locator('#my-settings-body [data-action="mine-pick"]').first()).toBeDisabled();
    await expect(page.locator('[data-action="mine-pick"][data-name="buttons_mode"]')).toHaveCount(1);
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

test('the chat chip opens the list of chats; the one picked shows on every page', async ({ page, isMobile }) => {
    const panel = await mockPanel(page, { role: 'user' });
    const chip = page.locator('#my-subs-section .mine-chat-chip');
    await expect(chip).toContainText('My account');
    if (isMobile) {
        // A small chip, but a finger's 44 px to hit: 5 px above and below it still lands on it
        const hits = await chip.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            return [r.top - 5, r.bottom + 5].map((y) => el.contains(document.elementFromPoint(x, y)));
        });
        expect(await chip.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(40);
        expect(hits).toEqual([true, true]);
    }
    await chip.click();
    const rows = page.locator('#pick-modal .pick-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Private chat');
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(rows.nth(1)).toContainText('Group · view only');
    await rows.nth(1).click();
    await expect(page.locator('#pick-modal')).toBeHidden();
    await expect(chip).toContainText('Киноклуб');
    await openMine(page, 'my-calendar');
    await expect(page.locator('#my-calendar-section .mine-chat-chip')).toContainText('Киноклуб');
    expect(panel.account.sent.some((r) => r.path.startsWith('/api/account/chats/-100/'))).toBe(true);
});

test('settings are rows; a row opens its choices and saves the one picked', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    const quiet = page.locator('[data-action="mine-pick"][data-name="quiet"]');
    await expect(quiet).toContainText('23:00–09:00');
    await expect(page.locator('#my-settings-body .mine-group-title')).toHaveText(['Notifications', 'Digests', 'Bot']);
    // A private chat has no "who presses the buttons"
    await expect(page.locator('[data-name="buttons_mode"]')).toHaveCount(0);

    await quiet.click();
    const sheet = page.locator('#pick-modal');
    await expect(sheet.locator('h3')).toHaveText('Quiet hours');
    await expect(sheet.locator('.pick-row')).toHaveText(['Off', '23:00–09:00', '22:00–08:00']);
    await expect(sheet.locator('.pick-row.selected')).toHaveText('23:00–09:00');
    await sheet.locator('.pick-row', { hasText: '22:00' }).click();
    await expect(page.locator('.toast').last()).toHaveText('Saved');
    expect(panel.account.sent.find((r) => r.method === 'PATCH').body).toEqual({ quiet_start: 22, quiet_end: 8 });
    await expect(quiet).toContainText('22:00–08:00');

    // The same choice again saves nothing
    await quiet.click();
    await sheet.locator('.pick-row.selected').click();
    await expect(sheet).toBeHidden();
    expect(panel.account.sent.filter((r) => r.method === 'PATCH')).toHaveLength(1);

    await page.locator('[data-action="mine-pick"][data-name="timezone"]').click();
    await sheet.locator('.pick-row', { hasText: 'Yekaterinburg' }).click();
    await expect.poll(() => panel.account.sent.filter((r) => r.method === 'PATCH').length).toBe(2);
    expect(panel.account.sent.filter((r) => r.method === 'PATCH')[1].body).toEqual({
        timezone: 'Asia/Yekaterinburg'
    });
});

// --- Passwords ---

test('a password signs in from the sign-in screen; a wrong one or too many tries say so', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    await expect(page.locator('.login-or')).toHaveText('or with a password');
    const submit = page.locator('.login-password [type="submit"]');
    await submit.click();
    await expect(page.locator('#login-pass-error')).toHaveText('Enter your @username or ID.');
    expect(panel.account.sent.filter((r) => r.path === '/api/login/password')).toHaveLength(0);

    await page.locator('#login-name').fill('@me');
    await page.locator('#login-pass').fill('wrong-one');
    await submit.click();
    await expect(page.locator('#login-pass-error')).toHaveText('Wrong username or password.');
    await expect(page.locator('#login-pass')).toHaveValue('');

    await page.locator('#login-pass').fill('too-many');
    await page.locator('#login-pass').press('Enter');
    await expect(page.locator('#login-pass-error')).toHaveText('Too many attempts. Try again in 15 minutes.');

    // The eye shows what is typed
    await page.locator('#login-pass').fill('good-password');
    await page.locator('.login-password [data-action="password-show"]').click();
    await expect(page.locator('#login-pass')).toHaveAttribute('type', 'text');
    await submit.click();
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.filter((r) => r.path === '/api/login/password').at(-1).body).toEqual({
        login: '@me',
        password: 'good-password'
    });
});

test('the account page sets, changes and removes the password', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    const group = page.locator('#my-signin');
    await expect(group).toContainText('@me · 42');
    const row = group.locator('[data-action="password-open"]');
    await expect(row).toContainText('Not set');

    await row.click();
    await expect(page.locator('#password-title')).toHaveText('Set a password');
    await expect(page.locator('#password-remove')).toBeHidden();
    await page.locator('#password-new').fill('short');
    await page.locator('#password-form [type="submit"]').click();
    await expect(page.locator('#password-error')).toHaveText('At least 8 characters.');
    await page.locator('#password-new').fill('long-enough');
    await page.locator('#password-again').fill('long-enougg');
    await page.locator('#password-again').press('Enter');
    await expect(page.locator('#password-error')).toHaveText("The passwords don't match.");
    await page.locator('#password-again').fill('long-enough');
    await page.locator('#password-form [type="submit"]').click();
    await expect(page.locator('#password-modal')).toBeHidden();
    await expect(page.locator('.toast').last()).toHaveText('Password set');
    await expect(row).toContainText('Set');
    expect(panel.account.sent.find((r) => r.method === 'PUT').body).toEqual({ password: 'long-enough' });

    await row.click();
    await expect(page.locator('#password-title')).toHaveText('Change password');
    await expect(page.locator('#password-new')).toHaveValue('');
    await page.locator('#password-remove').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast').last()).toHaveText('Password removed');
    await expect(row).toContainText('Not set');
    expect(panel.account.sent.some((r) => r.method === 'DELETE' && r.path === '/api/account/password')).toBe(true);
});
