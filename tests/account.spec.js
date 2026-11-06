// Signing in to the panel and the user's own chats in it, on the API mock (tests/mock-account.js)
const { test, expect } = require('@playwright/test');
const { watchConsole, isNarrow, pickChat, openProfilePage, profileButton, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// A 401 is the answer the panel expects before sign-in (and to a wrong password, a 429 to too many
// tries, a 503 to the chats while Telegram is down, a 409 to a Mini App launch over another account, a 403 to a password removal refused):
// the browser logs it as a failed load, and the refresh that met it logs its error
watchConsole({ ignore: /status of (4(01|03|09|29)|503)|Sign in to the panel\./ });

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

test('Mini App sign-in continues if Telegram rejects the swipe setting', async ({ page }) => {
    await page.addInitScript(() => {
        window.TelegramWebviewProxy = {
            postEvent(event) {
                if (event === 'web_app_setup_swipe_behavior') throw new Error('Unsupported bridge event');
            }
        };
    });
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user' });
    await expect(page.locator('body')).toHaveClass(/role-user/);
});

for (const role of ['user', 'admin']) {
    test(`a Mini App opened from a group opens that group's subscriptions (${role})`, async ({ page }) => {
        await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
        const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
        const panel = await mockPanel(page, { path, signedOut: true, role, miniAppChat: '-100' });
        await expect(page.locator('#my-subs-section')).toBeVisible();
        await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');
        await expect
            .poll(() => panel.account.sent.some((r) => r.path.startsWith('/api/account/chats/-100/')))
            .toBe(true);
        expect(panel.account.sent.some((r) => r.path.startsWith('/api/account/chats/42/'))).toBe(false);
    });
}

test('a retry after a failed account check still opens the group the Mini App came from', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user', miniAppChat: '-100', meFails: [503] });
    await page.locator('#login-body [data-action="login-retry"]').click();
    await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');
});

test('a Mini App opened from a group hidden in the menu still opens that group', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user', miniAppChat: '-100', groupHidden: true });
    await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');
    await profileButton(page, 'my-subs').click();
    await expect(page.locator('#pick-modal .pick-row.selected')).toContainText('Киноклуб');
});

test('the chat chip names the open chat on every tab; the Account tab shows its avatar', async ({ page }) => {
    await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await expect(profileButton(page, 'my-subs')).toContainText('My account');
    await expect(page.locator('[data-chat-context]')).toHaveCount(0);
    await expect(page.locator('.tab-profile-label')).toHaveText('Account');
    await pickChat(page, 'my-subs', 'Киноклуб');
    for (const id of ['my-subs', 'my-aired', 'my-calendar'])
        await expect(profileButton(page, id)).toContainText('Киноклуб');
    // Chat settings names the chat on its card instead
    await openMine(page, 'my-settings');
    await expect(page.locator('#my-settings-body .chat-card .card-name')).toHaveText('Киноклуб');
    await expect(page.locator('.tab-profile-label')).toHaveText('Account');
    await expect(page.locator('[data-tab-chat-avatar]')).toHaveText('К');
    if (isNarrow(page)) {
        await expect(page.locator('.tab-profile [data-profile-avatar]')).toBeHidden();
        await expect(page.locator('[data-tab-chat-avatar]')).toBeVisible();
    }
});

test('a Mini App launch naming a chat the user cannot open falls back to their own', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user', miniAppChat: '-999' });
    await expect(profileButton(page, 'my-subs')).toContainText('My account');
});

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
    // The main action 48px high, the other 44 (redesign handoff)
    const heights = await Promise.all([retry, password].map((el) => el.evaluate((b) => b.offsetHeight)));
    expect(heights).toEqual([48, 44]);
    await expect(page.locator('#login-tg, [data-action="login-qr"]')).toHaveCount(0);
    // The password form's way back returns to this screen, not the bot link. In the Mini App Telegram's
    // own Back button too, but the page keeps its round one: Telegram for iPhone showed none (06.11)
    await page.locator('#login-body [data-action="login-password"]').click();
    await expect(page.locator('#login-back')).toBeVisible();
    await expect(page.locator('#login-back')).toBeFocused();
    expect(events).toContain('web_app_setup_back_button');
    await page.evaluate(() => window['Telegram'].WebView.receiveEvent('back_button_pressed', null));
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
    // An admin reaches the personal tabs through the Account tab (their headers' chip)
    if (admin) await page.locator('.section.active [data-admin-profile] a').click();
    if (!isNarrow(page)) {
        return page.locator(`.nav-item[data-section="${section}"]`).click();
    }
    return page.locator(`.tab-item[data-section="${section}"]`).click();
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
    await expect(page.getByRole('button', { name: 'QR code' })).toBeVisible();
    await expect(page.locator('.login-or')).toHaveText('Other ways to sign in');
    await expect(page.locator('[data-action="login-password"]')).toBeVisible();
    await expect(page.locator('#login-name')).toHaveCount(0);
    const tiles = await page
        .locator('.login-method')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(tiles.every((height) => height === 76)).toBe(true);
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
        // The keyboard sees the focus ring (redesign handoff), not an underline
        await expect(telegram).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'QR code' })).toBeFocused();
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

test('a home-screen web app opens the Telegram app itself and checks the sign-in as soon as it is back', async ({
    page
}) => {
    await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });
        // The app's own scheme leaves the page; here the click only starts the wait
        window.addEventListener(
            'click',
            (event) => {
                if (event.target instanceof Element && event.target.closest('a[href^="tg:"]')) event.preventDefault();
            },
            true
        );
    });
    const panel = await mockPanel(page, { signedOut: true });
    const telegram = page.locator('#login-tg');
    await expect(telegram).toHaveAttribute('href', 'tg://resolve?domain=notfckbot&start=Lcode');
    await expect(telegram).not.toHaveAttribute('target', /.*/);
    await telegram.click();
    await expect(page.locator('#login-wait')).toBeVisible();
    await expect(page.locator('#login-body a[href^="tg://resolve"]')).not.toHaveAttribute('target', /.*/);
    // Two answers are needed (the mock confirms on the second): both come from coming back, not the timer
    const started = Date.now();
    for (let i = 0; i < 2; i += 1) {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await expect
            .poll(() => panel.account.sent.filter((r) => r.path === '/api/login/telegram/poll').length)
            .toBe(i + 1);
    }
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(Date.now() - started).toBeLessThan(1500);
});

test('"Code in the bot": the digits and how to send them, and the page signs in once the bot takes them', async ({
    page
}) => {
    const panel = await mockPanel(page, { signedOut: true });
    const tiles = page.locator('.login-method');
    await expect(tiles).toHaveText(['QR code', 'Bot code', 'Password']);
    // One row of three, the same size
    const boxes = await tiles.evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().toJSON()));
    expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
    expect(boxes.every((b) => b.height === 76)).toBe(true);
    expect(await page.locator('[data-action="login-code"] use').getAttribute('href')).toBe('/vendor/lucide.svg#binary');
    await page.locator('[data-action="login-code"]:not([disabled])').click();
    await expect(page.locator('#login-step')).toHaveText('Bot code');
    await expect(page.locator('.login-check b')).toHaveText('042719');
    const steps = page.locator('#login-steps');
    await expect(steps).toContainText('Open @notfckbot on any device with Telegram.');
    await expect(steps).toContainText('Send /code 042719');
    await expect(page.locator('.login-code-link')).toHaveCount(0);
    await expect(page.locator('#login-body a.btn')).toHaveCount(0);
    await expect(page.locator('#login-wait')).toContainText('Waiting for the bot');
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
    expect(panel.account.sent.some((r) => r.path === '/api/login/telegram/poll')).toBe(true);
});

test('the waiting screen offers the code as plain text that turns into the steps', async ({ page, context }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    const link = page.getByRole('button', { name: 'Sign in with a code' });
    await expect(link).toBeVisible();
    // Text, not a button: no frame and no fill, the accent color, under the digits
    const look = await link.evaluate((el) => {
        const css = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const check = document.querySelector('.login-check').getBoundingClientRect();
        const button = document.querySelector('#login-body a.btn').getBoundingClientRect();
        const x = box.left + box.width / 2;
        // The tap area reaches past the short line: control-high, as a button would be
        const hit = (y) => document.elementFromPoint(x, y) === el;
        return {
            border: css.borderTopWidth,
            background: css.backgroundColor,
            below: box.top >= check.bottom,
            // Close to the digits above; the button sits at the bottom of the screen
            above: Math.round(box.top - check.bottom),
            under: Math.round(button.top - box.bottom),
            tap: hit(box.top - 8) && hit(box.bottom + 8)
        };
    });
    expect(look).toMatchObject({ border: '0px', background: 'rgba(0, 0, 0, 0)', below: true, tap: true });
    expect(look.above).toBeLessThanOrEqual(12);
    expect(look.under).toBeGreaterThan(0);
    await link.click();
    await expect(link).toHaveCount(0);
    const steps = page.locator('#login-steps');
    await expect(steps).toContainText('Send /code 042719, or go to Настройки → Вход по коду and send the digits.');
    // No emoji in the steps, and a little room before the button under them
    expect(await steps.evaluate((el) => /\p{Extended_Pictographic}/u.test(el.textContent))).toBe(false);
    const room = await steps.evaluate(
        (el) =>
            document.querySelector('#login-body a.btn').getBoundingClientRect().top - el.getBoundingClientRect().bottom
    );
    expect(room).toBeGreaterThanOrEqual(16);
    // "The bot replies…" stands a little apart from the list above it
    const apart = await steps.evaluate(
        (el) =>
            el.querySelector('p').getBoundingClientRect().top - el.querySelector('ol').getBoundingClientRect().bottom
    );
    expect(apart).toBeGreaterThanOrEqual(12);
    await expect(page.getByRole('link', { name: 'Open the bot again' })).toBeVisible();
    await expect(page.locator('#login-wait')).toContainText('Waiting for confirmation');
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
    // The logo over the name, both centred (redesign handoff)
    expect(title.y).toBeGreaterThanOrEqual(logo.y + logo.height);
    expect(Math.abs(title.x + title.width / 2 - logo.x - logo.width / 2)).toBeLessThan(2);
    expect([logo.width, logo.height]).toEqual([64, 64]);
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    await expect(page.locator('#login-body .login-text')).toHaveText(
        'Check that the bot shows the same code, then confirm the sign-in.'
    );
    // The top bar's round Back, 44px, the screen's title beside it at a phone's Following size (28px)
    const back = page.locator('#login-back');
    await expect(back).toHaveAccessibleName('All sign-in methods');
    expect(await back.evaluate((el) => [el.offsetWidth, el.offsetHeight])).toEqual([44, 44]);
    const stepTitle = await page.locator('#login-step').evaluate((el) => ({
        size: getComputedStyle(el).fontSize,
        gap: Math.round(
            el.getBoundingClientRect().left - document.getElementById('login-back').getBoundingClientRect().right
        )
    }));
    expect(stepTitle).toEqual({ size: '28px', gap: 4 });
    // Level with the account pages' titles (42px down the middle), clear of Telegram's blurred top edge
    const centre = await page
        .locator('#login-step')
        .evaluate((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2));
    expect(centre).toBe(42);
    await expect(page.locator('#login-step')).toHaveText('Confirm in Telegram');
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
    await expect(page.locator('#login-back')).toBeFocused();
    await expect(page.getByRole('link', { name: 'Open Telegram on this device' })).toHaveAttribute('href', /t\.me/);
    await expect(page.locator('#login-wait')).toContainText('4:', { timeout: 5000 });
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(1);
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
});

test('a one-time sign-in link signs in only after a press and opens the chat it came from', async ({ page }) => {
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
    expect(await visibleNav(page, nav)).toEqual(['my-calendar', 'my-aired', 'my-subs', 'my-profile']);
    await expect(page.locator('#my-subs-body button.title-row')).toHaveCount(2);
    // No admin request was made for a user (they would all be refused)
    expect(panel.account.sent.every((r) => r.path.startsWith('/api/account/'))).toBe(true);
});

test('an admin has the whole panel and their own chats too', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    await openMine(page, 'my-calendar', { admin: true });
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    await expect(page.locator('button.cal-row')).toHaveCount(2);
});

test("an admin's two views: the admin panel and My account, each with only its own sections", async ({ page }) => {
    await mockPanel(page);
    const nav = isNarrow(page) ? '.tabbar .tab-item' : '.rail-nav .nav-item';
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    expect(await visibleNav(page, nav)).not.toContain('my-subs');

    await openMine(page, 'my-calendar', { admin: true });
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    expect(await visibleNav(page, nav)).toEqual(['my-calendar', 'my-aired', 'my-subs', 'my-profile']);

    // Back through the Account tab's Admin panel row to the remembered admin section
    await openProfilePage(page, 'my-profile');
    await page.locator('#my-profile-body [data-action="view-admin"]').click();
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
    const tabs = page.locator('.tabbar .tab-item:visible');
    await expect(tabs).toHaveCount(4);
    await expect(tabs.first()).toHaveText('Calendar');
    await expect(tabs.last()).toHaveAttribute('data-section', 'my-profile');
});

test('subscriptions: running series, films and finished ones in their tabs', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    const rows = page.locator('#my-subs-body button.title-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Одни из нас');
    await expect(rows.first()).toContainText('S2E5');
    await expect(rows.first().locator('.row-badge')).toHaveText('Every episode');
    await expect(page.locator('[data-action="mine-subs-tab"]')).toHaveText(['Series2', 'Films1', 'Ended1']);
    await page.locator('[data-action="mine-subs-tab"][data-tab="films"]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Дюна');
    await page.locator('[data-action="mine-subs-tab"][data-tab="archive"]').click();
    await expect(rows.first()).toContainText('Тед Лассо');
});

test('a series card changes the mode and unsubscribes after a confirmation', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await page.locator('#my-subs-body button.title-row', { hasText: 'Одни из нас' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card).toBeVisible();
    await card.getByText('When the whole season is out').click();
    await expect(page.locator('.toast').last()).toHaveText('Notifications changed');
    expect(
        panel.account.sent.find((r) => r.method === 'POST' && r.path === '/api/account/chats/42/series').body
    ).toEqual({ tmdbId: 'tv_100', mode: 'season' });
    await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Unfollow', exact: true }).click();
    await expect(card).toBeHidden();
    await expect(page.locator('#my-subs-body button.title-row')).toHaveCount(1);
});

test('a card is a sheet: a cross in its corner, buttons one height, Kinopoisk with its logo', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await page.locator('#my-subs-body button.title-row', { hasText: 'Одни из нас' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/app-sheet/);
    const close = card.getByRole('button', { name: 'Close', exact: true });
    await expect(close).toHaveClass(/sheet-close/);
    const kp = card.getByRole('link', { name: 'Open on Kinopoisk' });
    await expect(kp.locator('.kp-logo use')).toHaveAttribute('href', '#kp-logo-symbol');
    const heights = await card
        .locator('.tc-actions > *')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThanOrEqual(1);
    for (const h of heights) expect(Math.abs(h - 44)).toBeLessThan(0.5);
    const box = await close.boundingBox();
    const content = await card.locator('.modal-content').boundingBox();
    expect(box.y - content.y).toBeLessThan(20);
    expect(content.x + content.width - (box.x + box.width)).toBeLessThan(20);
    await close.click();
    await expect(card).toBeHidden();
});

test('search: a series asks for the mode, a film is added at once, what is on the list is marked', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await page.getByRole('link', { name: 'Follow a title' }).click();
    await page.locator('#mine-q').fill('дюна');
    await page.locator('#mine-q').press('Enter');
    const results = page.locator('#mine-results .search-row');
    await expect(results).toHaveCount(3);
    await expect(results.nth(1).locator('.search-following')).toHaveText('Following');

    await results.nth(0).getByRole('button', { name: /^Follow / }).click();
    await page.locator('#mine-card-modal').getByText('Episode 1 and the whole season').click();
    await page.locator('#mine-card-modal').getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(results.nth(0).locator('.search-following')).toHaveText('Following');
    expect(panel.account.sent.find((r) => r.path === '/api/account/chats/42/series').body).toEqual({
        tmdbId: 'tv_500',
        mode: 'first_and_full'
    });

    await results.nth(2).getByRole('button', { name: /^Follow / }).click();
    await expect(results.nth(2).locator('.search-following')).toHaveText('Following');
    expect(panel.account.sent.find((r) => r.path === '/api/account/chats/42/films').body).toEqual({
        tmdbId: 'movie_8'
    });
});

test('search titles open the shared title card without adding anything', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await page.getByRole('link', { name: 'Follow a title' }).click();
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
    await page.locator('#mine-card-modal').getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(page.locator('#mine-card-modal')).toBeHidden();
    await expect(page.locator('#mine-results .search-row').nth(2).locator('.search-following')).toHaveText(
        'Following'
    );
});

test('calendar: one list of what is to come, series and films in their tabs, with posters; no period switch', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    const rows = body.locator('button.cal-row');
    // The episode already out is left out; a card per month under its name
    await expect(rows).toHaveCount(2);
    await expect(body.locator('ul.cal-list')).toHaveCount(2);
    await expect(body.locator('.group-title')).toHaveText(['November', 'January 2027']);
    await expect(body.locator('.cal-day')).toHaveText(['04Wed', '15Fri']);
    await expect(rows.first()).toContainText('Одни из нас');
    await expect(rows.first()).toContainText('S2E5 · Feel Her Love · season finale');
    await expect(rows.first().locator('.cal-when')).toHaveText('today');
    // No title from TMDB yet: a stand-in
    await expect(rows.nth(1)).toContainText('S4E1 · Episode 1 · season premiere');
    await expect(rows.first().locator('img.title-thumb')).toHaveAttribute('src', '/api/poster/w185/p1.jpg');
    // Only the Series / Films chips: no week, month or year, no paging
    await expect(body.locator('.cat-chips')).toHaveCount(1);
    await expect(body.getByRole('button', { name: /^(Week|Month|Year|Earlier|Later)$/ })).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.path.includes('/calendar?'))).toBe(false);
    // Films have their own chip; yesterday's release is still shown
    await body.getByRole('tab', { name: 'Films' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Мегалополис');
    await expect(rows.first().locator('.cal-when')).toHaveText('yesterday');
    await expect(rows.nth(1)).toContainText('Дюна: Часть третья');
    await expect(rows.nth(1).locator('.cal-when')).toHaveText('in 2 days');
});

test('calendar: an episode opens its card with Kinopoisk, not Kinopoisk itself', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const card = page.locator('#mine-card-modal');
    await page.locator('#my-calendar-body button.cal-row').first().click();
    await expect(card).toBeVisible();
    await expect(card.locator('h2')).toHaveText('Одни из нас');
    await expect(card.locator('.tc-facts')).toContainText('Series · 2 seasons');
    await expect(card.locator('.tc-date-label').first()).toHaveText('S2E5 · Feel Her Love');
    await expect(card.locator('.tc-date-value')).toHaveText('Nov 4, 2026 · season finale');
    await expect(card.locator('.tc-date-when')).toHaveText('today');
    await expect(card).toContainText('Ellie and Dina head out.');
    await expect(card.locator('.tc-rating')).toHaveText('8.7/ 10 · TMDB');
    await expect(card.locator('.tc-rating use')).toHaveAttribute('href', '/vendor/lucide.svg#star');
    await expect(card.getByRole('link', { name: 'Open on Kinopoisk' })).toHaveAttribute(
        'href',
        'https://www.kinopoisk.ru/series/1/'
    );
});

test('calendar: a film card counts down, expands its description and leaves missing data out', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    await body.getByRole('tab', { name: 'Films', exact: true }).click();
    await body.locator('button.cal-row', { hasText: 'Дюна: Часть третья' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card.locator('.tc-date-value')).toHaveText('Nov 6, 2026');
    await expect(card.locator('.tc-date-when')).toHaveText('in 2 days');
    await expect(card.locator('.tc-rating')).toContainText('7.4');
    const clamped = () => card.locator('.tc-overview').evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(await clamped()).toBe(true);
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect.poll(clamped).toBe(false);
    await card.getByRole('button', { name: 'Show less', exact: true }).click();
    expect(await clamped()).toBe(true);
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await body.locator('button.cal-row', { hasText: 'Мегалополис' }).click();
    await expect(card.locator('.tc-date-when')).toHaveText('yesterday');
    await expect(card.locator('.tc-rating')).toHaveText('Not rated on TMDB yet');
    await expect(card.locator('.tc-overview')).toHaveCount(0);
});

test('the panel opens on the own account, not on the group picked last time', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    await pickChat(page, 'my-settings', 'Киноклуб');
    await page.reload();
    await openMine(page, 'my-settings');
    await expect(page.locator('#my-settings-body .chat-card .card-name')).toHaveText(panel.account.chats[0].title);
});

test("a group's settings: a member sees them, unchangeable; an admin's change is saved", async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    await pickChat(page, 'my-settings', 'Киноклуб');
    await expect(page.locator('#my-settings-body .chat-settings-note')).toContainText('the group’s admins change them');
    await expect(page.locator('#my-settings-body .chat-card .row-meta')).toHaveText('Only admins change settings');
    await expect(page.locator('#my-settings-body .chat-card .role-chip')).toHaveText('Group');
    await expect(page.locator('#my-settings-body [data-action="mine-pick"]').first()).toBeDisabled();
    await expect(page.locator('#my-settings-body [data-action="mine-pick"] .row-chevron').first()).toBeHidden();
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
    await expect(page.locator('#my-subs-body button.title-row')).toHaveCount(2);
    panel.account.signedIn = false;
    await openMine(page, 'my-calendar');
    await expect(page.locator('#login-gate')).toBeVisible();
    await expect(page.locator('#login-error')).toContainText('Your session has ended');
});

test('on a phone a user has four tabs, big enough to tap, and nothing scrolls sideways', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone layout');
    await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-subs-body button.title-row')).toHaveCount(2);
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

test('the Account tab: who is signed in, the chats, both settings pages and Sign out with a confirmation', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    // Sign out lives only on the Account tab
    await expect(page.locator('[data-action="profile-signout"]:visible')).toHaveCount(0);
    await openProfilePage(page, 'my-profile');
    const body = page.locator('#my-profile-body');
    await expect(body.locator('.profile-card')).toContainText('@me');
    await expect(body.locator('.profile-card')).toContainText('Telegram · ID 42');
    await expect(body.locator('.profile-card .role-chip')).toHaveText('User');
    await expect(body.locator('.group-title')).toHaveText(['Chats', 'Settings']);
    await expect(body.locator('.chat-row')).toHaveCount(2);
    await expect(body.locator('.chat-row').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(body.locator('.chat-row').first().locator('.row-check')).toHaveCount(1);
    await expect(body.locator('[data-action="profile-visibility"]')).toContainText('Hidden chats');
    // A user has no Admin panel row
    await expect(body.locator('[data-action="view-admin"]')).toHaveCount(0);
    await expect(body.locator('[aria-labelledby="profile-settings"] .row-name')).toHaveText([
        'Chat settings',
        'Account settings'
    ]);

    // Chat settings, and Back to the Account tab
    await body.locator('[data-section="my-settings"]').click();
    await expect(page.locator('#my-settings-section')).toHaveClass(/active/);
    await expect(page.locator('#my-settings-body .group-title')).toHaveText(['Notifications', 'Digests', 'Bot']);
    await page.locator('#my-settings-section .mine-back').click();
    await expect(page.locator('#my-profile-section')).toHaveClass(/active/);

    // A chat row switches the chat
    await body.locator('.chat-row', { hasText: 'Киноклуб' }).click();
    await expect(body.locator('.chat-row', { hasText: 'Киноклуб' })).toHaveAttribute('aria-pressed', 'true');
    await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');

    await body.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(panel.account.sent.some((r) => r.path === '/api/logout')).toBe(false);
    await body.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#login-gate')).toBeVisible();
    expect(panel.account.sent.some((r) => r.path === '/api/logout')).toBe(true);
});

test('an admin sees an Admin panel row on the Account tab', async ({ page }) => {
    await mockPanel(page);
    await openMine(page, 'my-subs', { admin: true });
    await openProfilePage(page, 'my-profile');
    await expect(page.locator('#my-profile-body [aria-labelledby="profile-settings"] .row-name')).toHaveText([
        'Admin panel',
        'Chat settings',
        'Account settings'
    ]);
});

test('the Account tab keeps Account settings and Sign out when the chats could not load', async ({ page }) => {
    await mockPanel(page, { role: 'user', chatsDown: true });
    await expect(profileButton(page, 'my-subs')).toContainText('My account');
    await openProfilePage(page, 'my-profile');
    const body = page.locator('#my-profile-body');
    await expect(body.locator('.chat-row')).toHaveCount(0);
    await expect(body).toContainText("Couldn't load chats");
    await expect(body.locator('[aria-labelledby="profile-settings"] .row-name')).toHaveText(['Account settings']);
    await expect(body.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('Account settings: who is signed in, the role, and signing out on other devices', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-account');
    await expect(page.locator('#my-account-info')).toContainText('@me');
    await expect(page.locator('#my-account-info')).toContainText('Telegram · ID 42');
    await expect(page.locator('#my-account-info')).toContainText('User');
    await expect(page.locator('#my-signin')).toContainText('Connected');
    // Devices is a page of its own: the row says how many are signed in
    await expect(page.locator('#my-devices [data-action="devices-open"]')).toContainText('3 active');
    await page.locator('#my-devices [data-action="devices-open"]').click();
    await expect(page.locator('#my-devices-section')).toHaveClass(/active/);
    await page.locator('[data-action="devices-end-others"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Sign out of 2 other sessions?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast').last()).toHaveText('Signed out of other sessions');
    expect(panel.account.sent.some((r) => r.path === '/api/account/sessions/end-others')).toBe(true);
    await expect(page.locator('#devices-body')).toContainText('No other active sessions');
    await expect(page.locator('[data-action="devices-end-others"]')).toHaveCount(0);
    await page.locator('#my-devices-section .page-back').click();
    await expect(page.locator('#my-account-section')).toHaveClass(/active/);
    await page.locator('#my-account-section .mine-back').click();
    await expect(page.locator('#my-profile-section')).toHaveClass(/active/);
});

test('the chat chip opens the chats; the choice shows on every page', async ({ page, isMobile }) => {
    const panel = await mockPanel(page, { role: 'user' });
    const chip = profileButton(page, 'my-subs');
    await expect(chip).toContainText('My account');
    // A finger's 44px: the 36px pill takes hits 4px above and below it
    const hits = await chip.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        return [r.top - 3, r.bottom + 3].map((y) => el.contains(document.elementFromPoint(x, y)));
    });
    expect(await chip.evaluate((el) => el.getBoundingClientRect().height)).toBe(36);
    if (isMobile) expect(hits).toEqual([true, true]);
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

test('Chat settings: the chat on a card that opens the chats, rows with icon tiles, the choices on a sheet', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    const body = page.locator('#my-settings-body');
    const card = body.locator('.chat-card');
    await expect(card.locator('.card-name')).toHaveText(panel.account.chats[0].title);
    await expect(card.locator('.role-chip')).toHaveText('Private');
    await expect(card.locator('.row-meta')).toHaveText('Your personal chat');
    // The header has no chip of its own any more: the card is the way to the chats
    await expect(page.locator('#my-settings-section header .mine-chat-chip')).toHaveCount(0);
    await expect(body.locator('.group-row .row-tile svg use').first()).toHaveAttribute(
        'href',
        '/vendor/lucide.svg#moon'
    );
    await expect(body.locator('.group-row-static .row-meta')).toHaveText(['Mondays at 10:00', 'On the 1st at 10:00']);
    for (const title of await body.locator('.group-title').all())
        expect(await title.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');

    await body.locator('[data-action="mine-pick"][data-name="quiet"]').click();
    const sheet = page.locator('#pick-modal');
    await expect(sheet).toHaveClass(/app-sheet/);
    await expect(sheet.locator('.sheet-grabber')).toBeVisible({ visible: isNarrow(page) });
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    await card.click();
    await expect(page.locator('#pick-modal .pick-row', { hasText: 'Киноклуб' })).toBeVisible();
});

test('settings are rows; a row opens its choices and saves the one picked', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    const quiet = page.locator('[data-action="mine-pick"][data-name="quiet"]');
    await expect(quiet).toContainText('23:00–09:00');
    await expect(page.locator('#my-settings-body .group-title')).toHaveText(['Notifications', 'Digests', 'Bot']);
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
    await expect(submit).toHaveText('Sign in');
    // The fields' edges on the button's (06.11: they sat 4px inside)
    const edges = await page.evaluate(() =>
        ['#login-pass', '.login-password [type="submit"]'].map((sel) => {
            const box = document
                .querySelector(sel)
                .closest('.password-input, .input-field, button')
                .getBoundingClientRect();
            return [Math.round(box.left), Math.round(box.right)];
        })
    );
    expect(edges[0]).toEqual(edges[1]);
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
    await expect(page.locator('.login-check b')).toHaveText('042719');
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

test('Account settings: a profile card with the role as a chip, sign-in methods and Security, no Role row', async ({
    page
}) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-account');
    const info = page.locator('#my-account-info .group-card');
    await expect(info.locator('.profile-avatar')).toHaveText('M');
    await expect(info.locator('.card-name')).toHaveText('@me');
    await expect(info.locator('.role-chip')).toHaveText('User');
    await expect(info.locator('.row-meta')).toHaveText('Telegram · ID 42');
    await expect(info.locator('button, a, [tabindex]')).toHaveCount(0);
    await expect(page.locator('#my-account-section')).not.toContainText('Role');
    // Sentence-case titles, not capitals
    await expect(page.locator('#my-account-section .group-title')).toHaveText(['Sign-in methods', 'Security']);
    for (const title of await page.locator('#my-account-section .group-title').all())
        expect(await title.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
    // Telegram only shows its state: not a control
    const telegram = page.locator('#my-signin .group-row-static');
    await expect(telegram).toContainText('Telegram');
    await expect(telegram).toContainText('Connected');
    expect(await telegram.evaluate((el) => el.tagName)).toBe('DIV');
    await expect(page.locator('#my-signin')).toContainText(
        'A password lets you sign in when Telegram isn’t responding.'
    );
    // Security → Devices opens the Devices page
    const devices = page.locator('#my-devices [data-action="devices-open"]');
    await expect(devices).toContainText('Devices');
    await expect(devices).toContainText('3 active');
    await devices.click();
    await expect(page.locator('#my-devices-section')).toHaveClass(/active/);
});

test('the Password row: set it, then a sheet with Change and Remove; removal asks first', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-account');
    const row = page.locator('#my-signin [data-action="password-open"]');
    await expect(row).toContainText('Not set');
    await expect(row.locator('.row-status')).toHaveText('Off');
    // Removing is never on the page itself
    await expect(page.locator('#my-account-section [data-action="password-remove-own"]')).toHaveCount(0);

    // Not set: the row goes straight to setting one
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
    await expect(row.locator('.row-meta')).toHaveText(/^Changed \d{1,2} [A-Z][a-z]{2}$/);
    await expect(row.locator('.row-status')).toHaveText('On');
    expect(panel.account.sent.find((r) => r.method === 'PUT').body).toEqual({ password: 'long-enough' });

    // Set: the row opens the sheet
    await row.click();
    const sheet = page.locator('#password-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.locator('#password-sheet-title')).toHaveText('Password');
    await expect(sheet.locator('.sheet-state')).toHaveText(/^On · changed \d{1,2} [A-Z][a-z]{2}$/);
    await expect(sheet).toContainText('After removal you can only sign in with Telegram.');

    // Change: the sheet gives way to the form
    await sheet.locator('[data-action="password-change"]').click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#password-title')).toHaveText('Change password');
    await expect(page.locator('#password-new')).toHaveValue('');
    await page.locator('#password-modal [data-close="password-modal"]').click();

    // Remove: asked first; Cancel keeps it and the sheet
    await row.click();
    await sheet.locator('[data-action="password-remove-own"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Remove password?');
    await expect(page.locator('#confirm-text')).toHaveText('You’ll only be able to sign in with Telegram.');
    await expect(page.locator('#modal-confirm-btn')).toHaveText('Remove');
    await page.locator('#modal-cancel-btn').click();
    await expect(sheet).toBeVisible();
    expect(panel.account.sent.some((r) => r.method === 'DELETE')).toBe(false);

    await sheet.locator('[data-action="password-remove-own"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('.toast').last()).toHaveText('Password removed');
    await expect(row).toContainText('Not set');
    await expect(row.locator('.row-status')).toHaveText('Off');
    expect(panel.account.sent.filter((r) => r.method === 'DELETE' && r.path === '/api/account/password')).toHaveLength(
        1
    );
});

test('a refused password removal keeps the sheet open with the reason', async ({ page }) => {
    await mockPanel(page, { role: 'user', hasPassword: true, passwordRemoveFails: [403] });
    await openMine(page, 'my-account');
    await page.locator('#my-signin [data-action="password-open"]').click();
    const sheet = page.locator('#password-sheet');
    const remove = sheet.locator('[data-action="password-remove-own"]');
    await remove.click();
    await page.locator('#modal-confirm-btn').click();
    await expect(sheet.locator('#password-sheet-error')).toContainText('one day after its first sign-in');
    await expect(sheet).toBeVisible();
    await expect(remove).toBeEnabled();
    await expect(remove).toHaveText('Remove password');
    await expect(page.locator('#my-signin [data-action="password-open"] .row-status')).toHaveText('On');
});

test('the Password sheet works from the keyboard: Escape closes it and focus returns to the row', async ({ page }) => {
    test.skip(isNarrow(page), 'a keyboard');
    await mockPanel(page, { role: 'user', hasPassword: true });
    await openMine(page, 'my-account');
    const row = page.locator('#my-signin [data-action="password-open"]');
    await row.focus();
    await page.keyboard.press('Enter');
    const sheet = page.locator('#password-sheet');
    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('password-sheet').contains(document.activeElement))).toBe(
        true
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(row).toBeFocused();
    // Removed from the keyboard: the redrawn row keeps the focus, not the page
    await page.keyboard.press('Enter');
    await sheet.locator('[data-action="password-remove-own"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('#modal-confirm-btn').click();
    await expect(sheet).toBeHidden();
    await expect(row.locator('.row-status')).toHaveText('Off');
    await expect(row).toBeFocused();
});

test('the Mini App turns off Telegram swipe-to-close once so pull to refresh works', async ({ page }) => {
    const events = [];
    await page.exposeFunction('telegramEvent', (event, data) => events.push([event, data]));
    await page.addInitScript(
        () => (window.TelegramWebviewProxy = { postEvent: (event, data) => window['telegramEvent'](event, data) })
    );
    const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
    await mockPanel(page, { path, signedOut: true, role: 'user' });
    await expect(page.locator('body')).toHaveClass(/role-user/);
    await expect.poll(() => events.map(([event]) => event)).toContain('web_app_ready');
    const swipes = events.filter(([event]) => event === 'web_app_setup_swipe_behavior');
    expect(swipes).toEqual([['web_app_setup_swipe_behavior', '{"allow_vertical_swipe":false}']]);
});

test('an on-screen keyboard hides the tab bar; focus alone (hardware keyboard) keeps it', async ({ page }) => {
    test.skip(!isNarrow(page), 'tab bar layout');
    await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    const tabbar = page.locator('.tabbar');
    const size = page.viewportSize();
    await page.locator('#my-subs-section [data-action="mine-search-open"]').first().click();
    await page.locator('#mine-q').focus();
    await expect(tabbar).toBeVisible();
    // The keyboard comes up: the visible area gets much shorter, as in Telegram's webview
    await page.setViewportSize({ width: size.width, height: size.height - 300 });
    await expect(tabbar).toBeHidden();
    await page.locator('#mine-q').blur();
    await expect(tabbar).toBeVisible();
    await page.setViewportSize(size);
});

test('the tab header: title and chat chip on one row, the line, the search pill under it; tabs in order', async ({
    page
}) => {
    await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await expect(page.locator('#my-subs-section h1')).toBeVisible();
    await expect(page.locator('[data-section="my-aired"] use').first()).toHaveAttribute(
        'href',
        '/vendor/lucide.svg#clapperboard'
    );
    // No magnifier button in the header any more: the pill is the way to the search
    await expect(page.locator('[data-action="mine-filter-toggle"]')).toHaveCount(0);
    const layout = await page.evaluate(() => {
        const box = (sel) => document.querySelector(sel).getBoundingClientRect();
        const h1 = box('#my-subs-section h1');
        const chip = box('#my-subs-section .mine-chat-chip');
        const sub = box('#my-subs-section .tab-top-sub');
        const pill = box('#my-subs-section .search-pill');
        return {
            sameRow: Math.abs(h1.top + h1.height / 2 - (chip.top + chip.height / 2)) < 2,
            chipRight: Math.round(document.querySelector('#my-subs-section header').getBoundingClientRect().right - chip.right),
            subGap: Math.round(sub.top - Math.max(h1.bottom, chip.bottom)),
            pillGap: Math.round(pill.top - sub.bottom),
            pillHeight: pill.height
        };
    });
    expect(layout.sameRow).toBe(true);
    expect(Math.abs(layout.chipRight)).toBeLessThan(2);
    expect(layout.pillGap).toBe(16);
    expect(layout.pillHeight).toBe(44);
    if (!isNarrow(page)) return;
    expect(await visibleNav(page, '.tabbar .tab-item')).toEqual(['my-calendar', 'my-aired', 'my-subs', 'my-profile']);
    await expect(page.locator('.tabbar .tab-profile .tab-profile-label')).toHaveText('Account');
    const tab = page.locator('.tabbar .tab-item.active');
    await expect(tab).toHaveAttribute('data-section', 'my-subs');
    // The capsule's own pill behind the whole tab, not a bar on its edge or a fill behind the icon
    const marks = await tab.evaluate((el) => ({
        bar: getComputedStyle(el, '::before').content,
        tab: getComputedStyle(el).backgroundColor,
        icon: getComputedStyle(el.querySelector('.icon')).backgroundColor
    }));
    expect(marks.bar).toBe('none');
    expect(marks.tab).toBe('rgba(255, 255, 255, 0.1)');
    expect(marks.icon).toBe('rgba(0, 0, 0, 0)');
    // The search page counts under Following
    await page.locator('#my-subs-section .search-pill').click();
    await expect(page.locator('.tabbar .tab-item[data-section="my-subs"]')).toHaveAttribute('aria-current', 'true');
});

test('a long chat name in the chip ends in an ellipsis at 180px', async ({ page }) => {
    const long = 'Очень длинное название киноклуба для проверки вёрстки';
    await mockPanel(page, { role: 'user', path: '/#my-subs' });
    const chip = page.locator('#my-subs-section .mine-chat-chip');
    await expect(chip).toBeVisible();
    const sizes = await chip.evaluate((el, title) => {
        const name = el.querySelector('.mine-chat-chip-name');
        name.textContent = title;
        return {
            width: el.getBoundingClientRect().width,
            clipped: name.scrollWidth > name.clientWidth,
            ellipsis: getComputedStyle(name).textOverflow
        };
    }, long);
    expect(sizes.width).toBeLessThanOrEqual(180);
    expect(sizes.clipped).toBe(true);
    expect(sizes.ellipsis).toBe('ellipsis');
});
