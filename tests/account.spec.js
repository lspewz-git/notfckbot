// Signing in to the panel and the user's own chats in it, on the API mock (tests/mock-account.js)
const { test, expect } = require('@playwright/test');
const { watchConsole, isNarrow, pickChat, openProfilePage, profileButton } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// A 401 is the answer the panel expects before sign-in (and to a wrong password, a 429 to too many
// tries, a 503 to the chats while Telegram is down, a 409 to a Mini App launch over another account):
// the browser logs it as a failed load, and the refresh that met it logs its error
watchConsole({ ignore: /status of (4(01|09|29)|503)|Sign in: \/login in the bot/ });

for (const [native, query] of [
    [true, '?miniapp=1'],
    [true, ''],
    [false, '?miniapp=1']
]) {
    test(`Mini App launch data only signs in through the native Telegram bridge (${native}, "${query}")`, async ({
        page
    }) => {
        if (native) await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
        const initData = 'auth_date=123&hash=test';
        const path = `/${query}#${new URLSearchParams({ tgWebAppData: initData })}`;
        const panel = await mockPanel(page, { path, signedOut: true, role: 'user' });
        if (native) await expect(page.locator('body')).toHaveClass(/role-user/);
        else await expect(page.locator('#login-tg')).toBeVisible();
        const requests = panel.account.sent.filter((request) => request.path === '/api/login/miniapp');
        expect(requests.map((request) => request.body)).toEqual(native ? [{ initData }] : []);
        expect(page.url()).not.toContain('tgWebAppData');
    });
}

test('a failed Mini App sign-in offers a retry and a password, not the bot link that closes the app', async ({
    page
}) => {
    const events = [];
    await page.exposeFunction('telegramEvent', (event) => events.push(event));
    await page.addInitScript(
        () => (window.TelegramWebviewProxy = { postEvent: (event) => window['telegramEvent'](event) })
    );
    const initData = 'auth_date=123&hash=test';
    const path = `/#${new URLSearchParams({ tgWebAppData: initData })}`;
    const panel = await mockPanel(page, { path, signedOut: true, role: 'user', miniAppFails: [503] });
    const retry = page.locator('#login-body [data-action="login-retry"]');
    await expect(retry).toBeVisible();
    await expect(page.locator('#login-error')).toHaveText('Mini App sign-in failed (503)');
    await expect(page.locator('#login-code')).toHaveText('503 · Service Unavailable');
    const password = page.locator('#login-body [data-action="login-password"]');
    await expect(password).toBeVisible();
    // The outline button keeps the primary one's height (44px touch target on a phone)
    const heights = await Promise.all([retry, password].map((el) => el.evaluate((b) => b.offsetHeight)));
    expect(heights[1]).toBe(heights[0]);
    await expect(page.locator('#login-tg, [data-action="login-qr"]')).toHaveCount(0);
    // The password form's way back returns to this screen, not the bot link
    await page.locator('#login-body [data-action="login-password"]').click();
    await page.locator('#login-back').click();
    await retry.click();
    await expect(page.locator('body')).toHaveClass(/role-user/);
    const tries = panel.account.sent.filter((request) => request.path === '/api/login/miniapp');
    expect(tries.map((request) => request.body)).toEqual([{ initData }, { initData }]);
    await expect.poll(() => events).toContain('web_app_ready');
});

test('a password sign-in after a failed Mini App try does not send the kept launch data again', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    const panel = await mockPanel(page, { path, signedOut: true, miniAppFails: [503] });
    await page.locator('#login-body [data-action="login-password"]').click();
    await page.locator('#login-name').fill('admin');
    await page.locator('#login-pass').fill('good-password');
    await page.locator('#login-pass').press('Enter');
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.filter((request) => request.path === '/api/login/miniapp')).toHaveLength(1);
});

test('a late failed retry leaves the password form being filled alone', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    let answer;
    const held = new Promise((resolve) => (answer = resolve));
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, {
        path,
        signedOut: true,
        role: 'user',
        miniAppFails: [503, 503],
        miniAppWait: (n) => (n === 2 ? held : undefined)
    });
    await page.locator('#login-body [data-action="login-retry"]').click();
    await page.locator('#login-body [data-action="login-password"]').click();
    await page.locator('#login-name').fill('@me');
    answer();
    // The retry's 503 has landed by the time the next request is answered
    await expect.poll(() => page.evaluate(() => document.querySelector('#login-name')?.value)).toBe('@me');
    await page.waitForTimeout(300);
    await expect(page.locator('#login-name')).toHaveValue('@me');
    await expect(page.locator('#login-code')).toHaveCount(0);
});

test('a failed retry keeps focus on the sign-in screen', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user', miniAppFails: [503, 503] });
    await page.locator('#login-body [data-action="login-retry"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#login-title')).toBeFocused();
    await expect(page.locator('#login-body [data-action="login-retry"]')).toBeEnabled();
});

test('another account in the Mini App window: Sign out, then the same launch signs in', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const initData = 'auth_date=123&hash=test';
    const path = `/#${new URLSearchParams({ tgWebAppData: initData })}`;
    const panel = await mockPanel(page, { path, signedOut: true, role: 'user', miniAppFails: [409] });
    await expect(page.locator('#login-code')).toHaveText('409 · Conflict');
    await page.locator('#login-body [data-action="miniapp-signout"]').click();
    await expect(page.locator('body')).toHaveClass(/role-user/);
    const sent = panel.account.sent.map((request) => request.path);
    expect(sent.filter((p) => p === '/api/logout')).toHaveLength(1);
    expect(panel.account.sent.filter((request) => request.path === '/api/login/miniapp').map((r) => r.body)).toEqual([
        { initData },
        { initData }
    ]);
});

test('Mini App launch data that cannot be used again offers to reopen the app', async ({ page }) => {
    const events = [];
    await page.exposeFunction('telegramEvent', (event) => events.push(event));
    await page.addInitScript(
        () => (window.TelegramWebviewProxy = { postEvent: (event) => window['telegramEvent'](event) })
    );
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user', miniAppFails: [401] });
    await expect(page.locator('#login-code')).toHaveText('401 · Unauthorized');
    await page.locator('#login-body [data-action="miniapp-close"]').click();
    await expect(page.locator('#login-body [data-action="login-retry"]')).toHaveCount(0);
    await expect.poll(() => events).toContain('web_app_close');
});

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
 * the tab bar (a user) or More (an admin). Chat / Account settings: from the profile menu
 */
async function openMine(page, section, { admin = false } = {}) {
    if (section === 'my-settings' || section === 'my-account') {
        await openMine(page, 'my-subs', { admin });
        return openProfilePage(page, section);
    }
    if (admin) {
        await page.locator('.section.active [data-admin-profile] button').click();
        await page.locator('#profile-modal [data-action="view-mine"]').click();
    }
    if (!isNarrow(page)) {
        return page.locator(`.nav-item[data-section="${section}"]`).click();
    }
    if (!admin) return page.locator(`.tab-item[data-section="${section}"]`).click();
    if (section !== 'my-subs') await page.locator(`.tab-item[data-section="${section}"]`).click();
}

for (const options of [{ signedOut: true }, { role: 'user' }, {}]) {
    test(`the first paint hides the panel until the session is known (${options.signedOut ? 'signed out' : options.role || 'admin'})`, async ({
        page
    }) => {
        let release;
        const hold = new Promise((resolve) => {
            release = resolve;
        });
        const loaded = mockPanel(page, { ...options, files: { 'js/app.js': hold } });
        try {
            await expect(page.locator('#dashboard-section')).toBeAttached();
            await expect(page.locator('.app-container')).toBeHidden();
            await expect(page.locator('.tabbar')).toBeHidden();
        } finally {
            release();
            await loaded;
        }
        if (options.signedOut) await expect(page.locator('#login-gate')).toBeVisible();
        else
            await expect(
                page.locator(options.role === 'user' ? '#my-subs-section' : '#dashboard-section')
            ).toBeVisible();
    });
}

test('without a session the sign-in screen covers the panel; the Telegram button is a link to the bot', async ({
    page,
    isMobile
}) => {
    const panel = await mockPanel(page, { signedOut: true });
    const gate = page.locator('#login-gate');
    await expect(gate).toBeVisible();
    await expect(page.locator('#login-tg')).toHaveAttribute('href', 'https://t.me/notfckbot?start=Lcode');
    await expect(page.locator('#login-tg')).toHaveText('Continue with Telegram');
    await expect(page.locator('#login-tg svg')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Telegram' })).toHaveAccessibleDescription(
        'You’ll confirm the sign-in in the NotFckBot chat.'
    );
    await expect(page.getByRole('button', { name: 'Scan a QR code' })).toBeVisible();
    await expect(page.locator('.login-or')).toHaveText('Other ways to sign in');
    await expect(page.locator('[data-action="login-password"]')).toBeVisible();
    await expect(page.locator('#login-name')).toHaveCount(0);
    const tiles = await page
        .locator('.login-method')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(tiles.every((height) => height >= 44 && height <= 68)).toBe(true);
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
    const telegram = page.locator('#login-tg');
    if (isMobile) {
        expect((await telegram.boundingBox()).height).toBeGreaterThanOrEqual(44);
    } else {
        await page.keyboard.press('Tab');
        await expect(telegram).toBeFocused();
        await expect(telegram).toHaveCSS('text-decoration-line', 'underline');
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Scan a QR code' })).toBeFocused();
    }
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

test('Telegram sign-in shows its logo', async ({ page }) => {
    await mockPanel(page, { signedOut: true });
    await expect(page.locator('#login-tg svg')).toBeVisible();
});

test('sign-in branding and confirmation fit without mixed-language instructions', async ({ page, context }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    const logo = await page.locator('.login-logo').boundingBox();
    const title = await page.locator('.login-card h1').boundingBox();
    expect(title.x).toBeGreaterThan(logo.x + logo.width);
    expect(Math.abs(title.y + title.height / 2 - logo.y - logo.height / 2)).toBeLessThan(2);
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    await expect(page.locator('#login-body .login-text')).toHaveText(
        'Check that the bot shows the same code, then confirm the sign-in.'
    );
    const back = page.locator('.login-back');
    await expect(back).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    expect(await back.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await back.click();
    await expect(page.locator('#login-tg')).toBeVisible();
    await expect(page.locator('#login-title')).toBeFocused();
});

test('confirmation stays usable when the browser clock is ahead of the server', async ({ page }) => {
    await page.addInitScript(() => {
        const now = Date.now.bind(Date);
        Date.now = () => now() + 360000;
    });
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    await page.locator('[data-action="login-qr"]:enabled').click();
    await expect(page.locator('.login-back')).toBeFocused();
    await expect(page.getByRole('link', { name: 'Open Telegram on this device' })).toHaveAttribute('href', /t\.me/);
    await expect(page.locator('#login-wait')).toContainText('4:', { timeout: 5000 });
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(1);
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
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
    expect(await visibleNav(page, nav)).toEqual(
        isNarrow(page) ? ['my-aired', 'my-subs', 'my-calendar', 'profile-open'] : ['my-aired', 'my-subs', 'my-calendar']
    );
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
        ? ['my-aired', 'my-subs', 'my-calendar', 'profile-open']
        : ['my-aired', 'my-subs', 'my-calendar'];
    expect(await visibleNav(page, isNarrow(page) ? nav : '.rail-nav .nav-item')).toEqual(mine);

    // Return through the shared profile to the remembered admin section.
    await profileButton(page, 'my-calendar').click();
    await page.locator('#profile-modal [data-action="view-admin"]').click();
    await expect(page.locator('#profile-modal')).toBeHidden();
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    expect(await visibleNav(page, nav)).not.toContain('my-calendar');
});

test('a user has no view switch', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-subs-section')).toHaveClass(/active/);
    await expect(page.locator('.view-switch')).toBeHidden();
    await expect(page.locator('.tab-admin')).toBeHidden();
});

test("on an admin's phone navigation appears once, with Account at the right edge", async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone layout');
    await mockPanel(page);
    await openMine(page, 'my-calendar', { admin: true });
    await expect(page.locator('.mine-switch')).toHaveCount(0);
    await expect(page.locator('#my-calendar-section .mine-chat')).toBeHidden();
    const tabs = page.locator('.tabbar .tab-item:visible');
    await expect(tabs).toHaveCount(4);
    await expect(tabs.first()).toHaveText('Released');
    await expect(tabs.last()).toHaveAttribute('data-action', 'profile-open');
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
    await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
    await card.getByRole('button', { name: 'Yes, unfollow' }).click();
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
        .locator('.mine-links .btn, [data-action="mine-ask-unfollow"]')
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

test('search titles open the shared series and film cards without adding anything', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.locator('#mine-q').fill('дюна');
    await page.locator('#mine-q').press('Enter');
    const rows = page.locator('#mine-results .search-result-open');
    await rows.first().click();
    await expect(page.locator('#mine-card-title')).toHaveText('Дюна: Пророчество');
    await expect(page.locator('#mine-card-modal .mine-modes')).toBeVisible();
    await page.locator('#mine-card-modal').getByRole('button', { name: 'Cancel' }).click();
    await rows.nth(2).click();
    await expect(page.locator('#mine-card-title')).toHaveText('Дюна');
    await expect(page.locator('#mine-card-modal .mine-modes')).toHaveCount(0);
    expect(panel.account.sent.filter((r) => r.method === 'POST' && r.path !== '/api/account/activity')).toHaveLength(0);
    await page.locator('#mine-card-modal').getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('#mine-card-modal')).toBeHidden();
    await expect(page.locator('#mine-results .mine-row').nth(2).locator('.mine-chip')).toHaveText('Added');
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
    await expect(card.locator('.mine-release-date time')).toHaveText('Nov 4, 2026');
    await expect(card.locator('.mine-release-date time')).toHaveAttribute('datetime', '2026-11-04');
    await expect(card.locator('.mine-card-head .mine-release-date')).toHaveCount(1);
    await expect(card.locator('.mine-release-count')).toHaveText('Today');
    await expect(card.locator('.title-rating')).toHaveText('8.7/ 10 · TMDB');
    await expect(card.locator('.title-rating use')).toHaveAttribute('href', '/vendor/lucide.svg#star');
    await expect(card.getByRole('link', { name: 'Kinopoisk' })).toHaveAttribute(
        'href',
        'https://www.kinopoisk.ru/series/1/'
    );
    await expect(card.getByRole('button', { name: /series card/i })).toHaveCount(0);
});

test('calendar: film dates and countdown are distinct, descriptions expand and missing metadata stays hidden', async ({
    page
}) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    await body.getByRole('button', { name: 'Films', exact: true }).click();
    await body.locator('.mine-cal-row', { hasText: 'Дюна: Часть третья' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card.locator('.mine-release-date time')).toHaveText('Nov 6, 2026');
    await expect(card.locator('.mine-release-count')).toHaveText('In 2 days');
    await expect(card.locator('.title-rating')).toContainText('7.4');
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(card.locator('[data-description-full]')).toBeVisible();
    await card.getByRole('button', { name: 'Show less', exact: true }).click();
    await expect(card.locator('[data-description-full]')).toBeHidden();
    const layout = await card.locator('.mine-release-date').evaluate((el) => {
        return {
            fits: el.scrollWidth <= el.clientWidth,
            border: getComputedStyle(el).borderStyle,
            inHeading: Boolean(el.closest('.mine-card-head'))
        };
    });
    expect(layout).toEqual({ fits: true, border: 'none', inHeading: true });
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await body.locator('.mine-cal-row', { hasText: 'Мегалополис' }).click();
    await expect(card.locator('.mine-release-count')).toHaveText('Yesterday');
    await expect(card.locator('.title-rating')).toHaveCount(0);
    await expect(card.locator('.mine-overview')).toHaveCount(0);
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

test('on a phone a user has four tabs, big enough to tap, and nothing scrolls sideways', async ({ page, isMobile }) => {
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
    expect(layout.tabs).toBe(4);
    expect(layout.tabHeight).toBeGreaterThanOrEqual(44);
    expect(layout.overflow).toBeLessThanOrEqual(0);
});

test('the profile menu: chats, both settings pages and Sign out; nothing else signs out in My account', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    // No Sign out in the rail, the tab bar or on a page: only in the menu
    await expect(page.locator('[data-action="logout"]:visible')).toHaveCount(0);
    const chip = profileButton(page, 'my-calendar');
    await openMine(page, 'my-calendar');
    await chip.click();
    const menu = page.locator('#profile-modal');
    await expect(menu.locator('.profile-head')).toContainText('@me');
    await expect(menu.locator('.profile-head')).toContainText('User · ID 42');
    await expect(menu.locator('.profile-links .action-title')).toHaveText([
        'Chat settings',
        'Account settings',
        'Sign out'
    ]);
    const box = await menu.locator('.modal-content').boundingBox();
    const chipBox = await chip.boundingBox();
    if (isNarrow(page)) {
        // A sheet on the bottom edge
        await expect
            .poll(async () => {
                const b = await menu.locator('.modal-content').boundingBox();
                return Math.round(b.y + b.height);
            })
            .toBe(page.viewportSize().height);
    } else {
        // Drops from the chip, right edges lined up
        expect(box.y).toBeGreaterThan(chipBox.y + chipBox.height);
        expect(Math.abs(box.x + box.width - (chipBox.x + chipBox.width))).toBeLessThan(2);
    }

    // Chat settings, and Back to the section the menu was opened from
    await menu.locator('[data-section="my-settings"]').click();
    await expect(page.locator('#my-settings-section')).toHaveClass(/active/);
    await expect(page.locator('#my-settings-body .mine-group-title')).toHaveText(['Notifications', 'Digests', 'Bot']);
    await page.locator('#my-settings-section .mine-back').click();
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);

    await chip.click();
    await menu.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#login-gate')).toBeVisible();
    expect(panel.account.sent.some((r) => r.path === '/api/logout')).toBe(true);
});

test('the chip opens the menu even when the chats could not load', async ({ page }) => {
    await mockPanel(page, { role: 'user', chatsDown: true });
    const chip = profileButton(page, 'my-subs');
    await expect(chip).toContainText('My account');
    await chip.click();
    await expect(page.locator('#profile-modal .pick-row')).toHaveCount(0);
    await expect(page.locator('#profile-modal .profile-links .action-title')).toHaveText([
        'Account settings',
        'Sign out'
    ]);
});

test('Account settings: who is signed in, the role, and signing out on other devices', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-account');
    await expect(page.locator('#my-account-info')).toContainText('@me');
    await expect(page.locator('#my-account-info')).toContainText('Telegram · ID 42');
    await expect(page.locator('#my-account-info')).toContainText('User');
    await expect(page.locator('#my-signin')).toContainText('Connected');
    await page.locator('[data-action="profile-end-others"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast').last()).toHaveText('Signed out on 2 other devices');
    expect(panel.account.sent.some((r) => r.path === '/api/account/sessions/end-others')).toBe(true);
    await page.locator('#my-account-section .mine-back').click();
    await expect(page.locator('#my-subs-section')).toHaveClass(/active/);
});

test('the profile button opens the chats; the choice shows on every page', async ({ page, isMobile }) => {
    const panel = await mockPanel(page, { role: 'user' });
    const chip = profileButton(page, 'my-subs');
    await expect(chip).toContainText('My account');
    if (isMobile) {
        // The avatar tab is at least a finger's 44 px and receives hits at its edges.
        const hits = await chip.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            return [r.top + 2, r.bottom - 2].map((y) => el.contains(document.elementFromPoint(x, y)));
        });
        expect(await chip.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        expect(hits).toEqual([true, true]);
    }
    await chip.click();
    const rows = page.locator('#profile-modal .pick-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Private chat');
    await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toContainText('Group · view only');
    await rows.nth(1).click();
    await expect(page.locator('#profile-modal')).toBeHidden();
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
    await page.locator('[data-action="login-password"]').click();
    const submit = page.locator('.login-password [type="submit"]');
    await expect(submit).toHaveText('Log In');
    const eye = page.locator('.login-password [data-action="password-show"]');
    await expect(eye.locator('path')).toHaveAttribute('d', 'm3 3 18 18');
    const layout = await eye.evaluate((button) => {
        const field = document.querySelector('#login-pass').getBoundingClientRect();
        const toggle = button.getBoundingClientRect();
        return {
            inside:
                toggle.left >= field.left &&
                toggle.right <= field.right &&
                toggle.top >= field.top &&
                toggle.bottom <= field.bottom,
            right: toggle.left > field.left + field.width / 2,
            border: getComputedStyle(button).borderWidth
        };
    });
    expect(layout).toEqual({ inside: true, right: true, border: '0px' });
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
    const eyeSvg = await eye.locator('svg').elementHandle();
    await page.locator('.login-password [data-action="password-show"]').click();
    await expect(page.locator('#login-pass')).toHaveAttribute('type', 'text');
    expect(await eyeSvg.evaluate((svg) => svg.isConnected)).toBe(true);
    await expect(eye.locator('.password-eye-slash')).toHaveCSS('opacity', '0');
    await expect(eye).toHaveAttribute('aria-label', 'Hide password');
    await eye.click();
    await expect(page.locator('#login-pass')).toHaveAttribute('type', 'password');
    await expect(eye.locator('path')).toHaveAttribute('d', 'm3 3 18 18');
    expect(await eyeSvg.evaluate((svg) => svg.isConnected)).toBe(true);
    await expect(eye.locator('.password-eye-slash')).toHaveCSS('opacity', '1');
    await expect(eye).toHaveAttribute('aria-label', 'Show password');
    await submit.click();
    await expect(page.locator('#login-wait')).toBeVisible();
    expect(panel.account.signedIn).toBe(false);
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.filter((r) => r.path === '/api/login/password').at(-1).body).toEqual({
        login: '@me',
        password: 'good-password'
    });
});

test('QR shares the Telegram confirmation and cancellation invalidates the pending attempt', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    await page.locator('[data-action="login-qr"]:enabled').click();
    await expect(page.locator('.login-qr')).toBeVisible();
    await expect(page.locator('.login-check b')).toHaveText('0427');
    await expect(page.locator('#login-wait')).toBeVisible();
    expect(panel.account.signedIn).toBe(false);
    await page.locator('[data-action="login-cancel"]').click();
    await expect(page.locator('[data-action="login-password"]')).toBeVisible();
    await expect.poll(() => panel.account.sent.some((r) => r.path === '/api/login/telegram/cancel')).toBe(true);
    await page.locator('[data-action="login-qr"]:enabled').click();
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
});

test('a refused or expired confirmation returns to the method picker', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    for (const [state, message] of [
        ['refused', 'cancelled in the bot'],
        ['gone', 'time to confirm has run out']
    ]) {
        panel.account.confirmationState = state;
        await page.locator('[data-action="login-qr"]:enabled').click();
        await expect(page.locator('#login-error')).toContainText(message, { timeout: 10000 });
        expect(panel.account.signedIn).toBe(false);
    }
});

test('the system password bypasses Telegram; deliberate panel use renews activity once per minute', async ({
    page
}) => {
    const panel = await mockPanel(page, { signedOut: true, system: true });
    await page.locator('[data-action="login-password"]').click();
    await page.locator('#login-name').fill('admin');
    await page.locator('#login-pass').fill('good-password');
    await page.locator('.login-password [type="submit"]').click();
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('#login-wait')).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.path === '/api/account/activity')).toBe(false);
    await page.locator('#dashboard-section h1').click();
    await expect.poll(() => panel.account.sent.filter((r) => r.path === '/api/account/activity').length).toBe(1);
    await page.locator('#dashboard-section h1').click();
    expect(panel.account.sent.filter((r) => r.path === '/api/account/activity')).toHaveLength(1);
});

test('the account page sets, changes and removes the password', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-account');
    const group = page.locator('#my-signin');
    await expect(group).toContainText('Connected');
    const row = group.locator('[data-action="password-open"]');
    const remove = group.locator('[data-action="password-remove-own"]');
    await expect(row).toContainText('Not set: Telegram sign-in only');
    await expect(row).toContainText('Set up');
    await expect(remove).toHaveCount(0);

    await row.click();
    await expect(page.locator('#password-title')).toHaveText('Set a password');
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
    await expect(row.locator('.mine-set-sub')).toHaveText(/^Set · changed \d{1,2} [A-Z][a-z]{2}/);
    await expect(row.locator('.mine-set-value')).toHaveText('OnChange');
    expect(panel.account.sent.find((r) => r.method === 'PUT').body).toEqual({ password: 'long-enough' });

    await row.click();
    await expect(page.locator('#password-title')).toHaveText('Change password');
    await expect(page.locator('#password-new')).toHaveValue('');
    await page.locator('#password-modal [data-close="password-modal"]').click();
    await remove.click();
    await expect(page.locator('#confirm-title')).toHaveText('Remove the password?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast').last()).toHaveText('Password removed');
    await expect(row).toContainText('Not set');
    await expect(remove).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.method === 'DELETE' && r.path === '/api/account/password')).toBe(true);
});
