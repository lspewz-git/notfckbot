// Signing in to the panel and the user's own chats in it, on the API mock (tests/mock-account.js)
const { test, expect } = require('@playwright/test');
const { watchConsole, isNarrow, pickChat, openProfilePage, profileButton, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// A 401 is the answer the panel expects before sign-in (and to a wrong password, a 429 to too many
// tries, a 503 to the chats while Telegram is down, a 409 to a Mini App launch over another account, a 403 to a password removal refused):
// the browser logs it as a failed load, and the refresh that met it logs its error
watchConsole({ ignore: /status of (4(01|03|09|29)|50[23])|Sign in to the panel\./ });

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
    test(`a Mini App opened from a group opens that group's Calendar (${role})`, async ({ page }) => {
        await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
        const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;
        const panel = await mockPanel(page, { path, signedOut: true, role, miniAppChat: '-100' });
        await expect(page.locator('#my-calendar-section')).toBeVisible();
        await expect(profileButton(page, 'my-calendar')).toContainText('Киноклуб');
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
    await expect(profileButton(page, 'my-calendar')).toContainText('Киноклуб');
    await profileButton(page, 'my-calendar').click();
    await expect(page.locator('#my-profile-body .chat-row[aria-pressed="true"]')).toContainText('Киноклуб');
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
    await expect(page.locator('#login-title')).toHaveText('Mini App sign-in failed (503)');
    await expect(page.locator('#login-code')).toHaveText('503 · Service Unavailable');
    const password = page.locator('#login-body [data-action="login-password"]');
    await expect(password).toBeVisible();
    // Both 48px high (SIGNIN.md)
    const heights = await Promise.all([retry, password].map((el) => el.evaluate((b) => b.offsetHeight)));
    expect(heights).toEqual([48, 48]);
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
    return openSection(page, section);
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
                page.locator(options.role === 'user' ? '#my-calendar-section' : '#dashboard-section')
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
    await expect(page.locator('#login-tg .login-tg-send')).toBeVisible();
    await expect(page.locator('#login-tg')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.getByRole('link', { name: 'Continue with Telegram' })).toHaveAccessibleDescription(
        'You’ll confirm the sign-in in the NotFckBot chat.'
    );
    await expect(page.locator('.login-or')).toHaveText('Other ways to sign in');
    await expect(page.locator('[data-action="login-password"]')).toBeVisible();
    await expect(page.locator('#login-name')).toHaveCount(0);
    // Three tiles 76 high on a phone and a computer alike: the QR is a way like the others, never shown at once
    const tiles = await page
        .locator('.login-method:visible')
        .evaluateAll((nodes) => nodes.map((node) => [node.textContent, node.getBoundingClientRect().height]));
    expect(tiles).toEqual([
        ['QR code', 76],
        ['Bot code', 76],
        ['Password', 76]
    ]);
    await expect(page.getByRole('img', { name: 'QR code for signing in' })).toHaveCount(0);
    if (!isMobile) await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    // One code for the one screen, and no "session ended" on a first visit
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(1);
    await expect(page.locator('.login-alert:visible')).toHaveCount(0);
    // Nothing of the panel can be reached under it
    const hit = await page.evaluate(() => {
        const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return Boolean(el && el.closest('#login-gate'));
    });
    expect(hit).toBe(true);
    const telegram = page.locator('#login-tg');
    if (isMobile) {
        expect((await telegram.boundingBox()).height).toBe(48);
    } else {
        await page.keyboard.press('Tab');
        await expect(telegram).toBeFocused();
        // The keyboard sees the focus ring (redesign handoff), not an underline
        await expect(telegram).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'QR code' })).toBeFocused();
    }
});

test('while the code comes, Telegram loads and QR code and Bot code wait; Password works at once', async ({ page }) => {
    let answer;
    const held = new Promise((resolve) => (answer = resolve));
    const panel = await mockPanel(page, { signedOut: true, telegramWait: () => held });
    const telegram = page.locator('#login-tg');
    await expect(telegram).toHaveAttribute('aria-busy', 'true');
    await expect(telegram).toHaveAttribute('aria-disabled', 'true');
    await expect(telegram).not.toHaveAttribute('href', /.*/);
    await expect(telegram.locator('.login-spin')).toBeVisible();
    await expect(page.locator('[data-action="login-code"]')).toBeDisabled();
    await expect(page.locator('[data-action="login-qr"]')).toBeDisabled();
    await expect(page.locator('[data-action="login-password"]')).toBeEnabled();
    answer();
    await expect(telegram).toHaveAttribute('href', /t\.me/);
    await expect(page.locator('[data-action="login-code"]')).toBeEnabled();
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(1);
});

test('Telegram not answering: its error under the button, QR code and Bot code off, Password on', async ({
    page,
    isMobile
}) => {
    await mockPanel(page, { signedOut: true, telegramFails: [503] });
    const error = page.locator('#login-tg-error');
    await expect(error).toHaveText(
        "Telegram isn't answering. Try again later. A password still works if you have set one."
    );
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.locator('#login-tg')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#login-tg')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('[data-action="login-code"]')).toBeDisabled();
    await expect(page.locator('[data-action="login-password"]')).toBeEnabled();
    // On a phone the error takes the hint's place
    if (isMobile) await expect(page.locator('#login-tg-hint')).toBeHidden();
    // The code is asked again by itself
    await expect(page.locator('#login-tg')).toHaveAttribute('href', /t\.me/, { timeout: 15000 });
    await expect(error).toBeHidden();
});

test('at 720px the layout switches between the phone and the card', async ({ page }) => {
    await page.setViewportSize({ width: 719, height: 800 });
    await mockPanel(page, { signedOut: true });
    const panel = page.locator('.login-pick-panel');
    const look = () =>
        panel.evaluate((el) => [getComputedStyle(el).borderTopWidth, Math.round(el.getBoundingClientRect().width)]);
    // A phone: no card, the column as wide as the screen allows
    expect(await look()).toEqual(['0px', 440]);
    await expect(page.locator('.login-heading')).toBeHidden();
    await page.setViewportSize({ width: 720, height: 800 });
    // The card: framed, 440 wide, "Sign in" over the ways in
    expect(await look()).toEqual(['1px', 440]);
    await expect(page.locator('.login-heading')).toBeVisible();
    await expect(page.locator('[data-action="login-qr"]')).toBeVisible();
});

test("the first screen keeps its code fresh but asks about it only on a way's screen", async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    await expect(page.locator('#login-tg')).toHaveAttribute('href', /t\.me/);
    await page.waitForTimeout(2000);
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram/poll')).toHaveLength(0);
});

test('"Continue with Telegram": the page waits for the answer in the bot, then opens the panel', async ({
    page,
    context
}) => {
    const panel = await mockPanel(page, { signedOut: true });
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    await expect(page.locator('#login-status')).toContainText('Waiting for confirmation…');
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
    await expect(page.locator('#login-status')).toBeVisible();
    await expect(page.locator('#login-body a[href^="tg://resolve"]').first()).not.toHaveAttribute('target', /.*/);
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

test('a hidden page neither polls nor counts down; back on screen it asks at once', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    await page.locator('[data-action="login-code"]:enabled').click();
    await expect(page.locator('#login-status')).toBeVisible();
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = panel.account.sent.filter((r) => r.path === '/api/login/telegram/poll').length;
    await page.waitForTimeout(3500);
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram/poll')).toHaveLength(before);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
        .poll(() => panel.account.sent.filter((r) => r.path === '/api/login/telegram/poll').length)
        .toBe(before + 1);
});

test('"Bot code": the digits to send, no field to type into, and the page signs in once the bot takes them', async ({
    page,
    context,
    browserName
}) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    expect(await page.locator('[data-action="login-code"] use').getAttribute('href')).toBe('#i-binary');
    await page.locator('[data-action="login-code"]:not([disabled])').click();
    await expect(page.locator('#login-step')).toHaveText('Send the code to the bot');
    await expect(page.locator('#login-back')).toBeFocused();
    await expect(page.locator('.login-lead')).toHaveText(
        'Open @notfckbot on any device with Telegram and send this message. Or open Настройки → Вход по коду and send the digits.'
    );
    await expect(page.locator('#login-digits')).toContainText('Your code');
    await expect(page.locator('#login-digits .login-digits-value')).toHaveText('042 719');
    await expect(page.locator('#login-digits .sr-only')).toHaveText('Code 0 4 2 7 1 9');
    expect(
        await page.locator('#login-digits .login-digits-value').evaluate((el) => getComputedStyle(el).fontSize)
    ).toBe('40px');
    await expect(page.locator('#login-command code')).toHaveText('/code 042719');
    await expect(page.locator('#login-body input')).toHaveCount(0);
    await expect(page.locator('#login-status')).toContainText('Waiting for the bot…');
    await expect(page.locator('#login-timer')).toHaveText(/^· [45]:\d\d$/);
    await expect(page.getByRole('link', { name: 'Open @notfckbot' })).toHaveAttribute('href', 'https://t.me/notfckbot');
    await expect(page.locator('.login-safety')).toHaveText('Only send a code from your own screen.');
    const copy = page.getByRole('button', { name: 'Copy' });
    expect(await copy.evaluate((el) => [el.offsetWidth, el.offsetHeight])).toEqual([44, 44]);
    await copy.click();
    await expect(page.locator('.toast')).toContainText('Copied');
    if (browserName === 'chromium')
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/code 042719');
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
});

test('"Sign in with a code" opens the code steps in place', async ({ page, context }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    const link = page.getByRole('button', { name: 'Sign in with a code' });
    await expect(link).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#login-code-help')).toBeHidden();
    expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await link.click();
    await expect(link).toHaveAttribute('aria-expanded', 'true');
    const help = page.locator('#login-code-help');
    await expect(help).toBeVisible();
    await expect(help).toContainText('Настройки → Вход по коду');
    await expect(help.locator('code')).toHaveText('/code 042719');
    await expect(help.getByRole('link', { name: 'Open @notfckbot' })).toHaveAttribute('href', 'https://t.me/notfckbot');
    expect(await help.evaluate((el) => /\p{Extended_Pictographic}/u.test(el.textContent))).toBe(false);
    await link.click();
    await expect(help).toBeHidden();
    await expect(page.getByRole('link', { name: 'Open Telegram again' })).toHaveAttribute('href', /t\.me/);
    await expect(page.locator('#login-status')).toContainText('Waiting for confirmation');
});

test('Telegram sign-in shows its logo', async ({ page }) => {
    await mockPanel(page, { signedOut: true });
    await expect(page.locator('#login-tg .login-tg-send')).toBeVisible();
});

test("the first screen and a way's screen follow the mockups at both sizes", async ({ page, context, isMobile }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    const logo = await page.locator('.login-logo').boundingBox();
    const title = await page.locator('#login-title').boundingBox();
    if (isMobile) {
        // The logo over the name, both centred
        expect(title.y).toBeGreaterThanOrEqual(logo.y + logo.height);
        expect(Math.abs(title.x + title.width / 2 - logo.x - logo.width / 2)).toBeLessThan(2);
        expect([logo.width, logo.height]).toEqual([64, 64]);
    } else {
        // The logo beside the name at the card's top left
        expect(title.x).toBeGreaterThan(logo.x + logo.width);
        expect([logo.width, logo.height]).toEqual([48, 48]);
    }
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    await expect(page.locator('.login-lead')).toHaveText(
        'We opened the NotFckBot chat. Check that the bot shows the same code and tap «Да, это я». This page will sign you in by itself.'
    );
    await expect(page.locator('#login-digits')).toContainText('The bot shows the same code');
    await expect(page.locator('#login-digits .login-digits-value')).toHaveText('042 719');
    await expect(page.locator('.login-safety')).toHaveText('Only confirm a sign-in you started.');
    // The round Back, 44px; the title under it at 28/34
    const back = page.locator('#login-back');
    await expect(back).toHaveAccessibleName('Back to sign-in options');
    expect(await back.evaluate((el) => [el.offsetWidth, el.offsetHeight])).toEqual([44, 44]);
    const step = await page.locator('#login-step').evaluate((el) => ({
        size: getComputedStyle(el).fontSize,
        line: getComputedStyle(el).lineHeight,
        below: el.getBoundingClientRect().top >= document.getElementById('login-back').getBoundingClientRect().bottom
    }));
    expect(step).toEqual({ size: '28px', line: '34px', below: true });
    await expect(page.locator('#login-step')).toHaveText('Confirm in Telegram');
    const safety = await page.locator('.login-safety').boundingBox();
    const open = await page.getByRole('link', { name: 'Open Telegram again' }).boundingBox();
    const panelBox = await page.locator('.login-step .login-panel').boundingBox();
    if (isMobile) {
        // The buttons at the bottom, the safety line over them
        expect(safety.y).toBeLessThan(open.y);
        expect(open.y).toBeGreaterThan(500);
    } else {
        // A 440 card; the safety line under the buttons, the Terms under the card
        expect(Math.round(panelBox.width)).toBe(440);
        expect(safety.y).toBeGreaterThan(open.y);
        await expect(page.locator('.login-terms-note')).toBeVisible();
    }
    await back.click();
    await expect(page.locator('#login-tg')).toBeVisible();
    await expect(page.locator('#login-title')).toBeFocused();
    await expect.poll(() => panel.account.sent.some((r) => r.path === '/api/login/telegram/cancel')).toBe(true);
});

test('confirmation stays usable when the browser clock is ahead of the server', async ({ page }) => {
    await page.addInitScript(() => {
        const now = Date.now.bind(Date);
        Date.now = () => now() + 360000;
    });
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    await page.locator('[data-action="login-code"]:enabled').click();
    await expect(page.locator('#login-back')).toBeFocused();
    await expect(page.locator('#login-timer')).toContainText('4:', { timeout: 5000 });
    expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(1);
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
});

test('a one-time sign-in link signs in only after a press and opens the chat it came from', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true, role: 'user', path: '/login/good-token' });
    // Opening the link spends nothing: a link preview only GETs
    expect(panel.account.sent.filter((r) => r.path === '/api/login')).toEqual([]);
    await expect(page.locator('.login-hint')).toHaveText('A sign-in link from the bot.');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.find((r) => r.path === '/api/login').body).toEqual({ token: 'good-token' });
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    await expect(page.locator('#my-calendar-section .mine-chat-chip')).toContainText('Киноклуб');
});

test('a used link says so, and Sign in again leads to the ways in', async ({ page }) => {
    await mockPanel(page, { signedOut: true, path: '/login/old-token' });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#login-error')).toHaveText('This link has expired. Sign in again.');
    await page.getByRole('button', { name: 'Sign in again' }).click();
    await expect(page.locator('#login-tg')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
});

test('a panel that does not answer says so with its status and offers Retry', async ({ page }) => {
    const panel = await mockPanel(page, { meFails: [502] });
    await expect(page.locator('#login-title')).toHaveText('The panel isn’t answering: Account check failed (502)');
    await expect(page.locator('#login-code')).toHaveText('502 · Bad Gateway');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.filter((r) => r.path === '/api/account/me')).toHaveLength(2);
});

test('a user sees only their own sections, and the panel asks for nothing else', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    const nav = isNarrow(page) ? '.tabbar .tab-item' : '.rail-nav .nav-item';
    expect(await visibleNav(page, nav)).toEqual(['my-calendar', 'my-aired', 'my-subs', 'my-profile']);
    await expect(page.locator('#my-calendar-body button.cal-row')).toHaveCount(2);
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
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
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
    await openSection(page, 'my-subs');
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
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body button.title-row', { hasText: 'Одни из нас' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /Notify me/ }).click();
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
    await openSection(page, 'my-subs');
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
    await openSection(page, 'my-subs');
    await page.getByRole('link', { name: 'Follow a title' }).click();
    await page.locator('#mine-q').fill('дюна');
    await page.locator('#mine-q').press('Enter');
    const results = page.locator('#mine-results .search-row');
    await expect(results).toHaveCount(3);
    await expect(results.nth(1).locator('.search-following')).toHaveText('Following');

    await results
        .nth(0)
        .getByRole('button', { name: /^Follow / })
        .click();
    await page
        .locator('#mine-card-modal')
        .getByRole('button', { name: /Notify me/ })
        .click();
    await page.locator('#mine-card-modal').getByText('Episode 1 and the whole season').click();
    await page.locator('#mine-card-modal').getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(results.nth(0).locator('.search-following')).toHaveText('Following');
    expect(panel.account.sent.find((r) => r.path === '/api/account/chats/42/series').body).toEqual({
        tmdbId: 'tv_500',
        mode: 'first_and_full'
    });

    await results
        .nth(2)
        .getByRole('button', { name: /^Follow / })
        .click();
    await expect(results.nth(2).locator('.search-following')).toHaveText('Following');
    expect(panel.account.sent.find((r) => r.path === '/api/account/chats/42/films').body).toEqual({
        tmdbId: 'movie_8'
    });
});

test('search titles open the shared title card without adding anything', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
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
    await expect(page.locator('#mine-results .search-row').nth(2).locator('.search-following')).toHaveText('Following');
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

test('calendar: every row shows its own day, also the second episode of the same day', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    const finale = panel.account.calendar.items.find((x) => x.episode === 5);
    panel.account.calendar.items.splice(panel.account.calendar.items.indexOf(finale), 0, {
        ...finale,
        episode: 4,
        mark: '',
        name: 'Day One'
    });
    await openMine(page, 'my-calendar');
    const days = page.locator('#my-calendar-body .cal-day');
    await expect(days).toHaveText(['04Wed', '04Wed', '15Fri']);
    for (const day of await days.all()) await expect(day).toBeVisible();
});

test('calendar: reopening shows the last list at once and keeps it when nothing changed', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    await expect(body.locator('button.cal-row')).toHaveCount(2);
    // Posters load with the list, not when scrolled to
    await expect(body.locator('img.cal-thumb[loading="lazy"]')).toHaveCount(0);
    await body
        .locator('button.cal-row')
        .first()
        .evaluate((row) => (row.dataset.kept = '1'));
    await openSection(page, 'my-subs');
    // The fresh answer waits: the old list stays, no skeleton
    let release = () => {};
    const hold = new Promise((resolve) => (release = resolve));
    await page.route('**/calendar', async (route) => {
        await hold;
        await route.fallback();
    });
    await openSection(page, 'my-calendar');
    await expect(body.locator('button.cal-row')).toHaveCount(2);
    await expect(body.locator('[aria-busy="true"]')).toHaveCount(0);
    release();
    await expect.poll(() => panel.account.sent.filter((r) => r.path.endsWith('/calendar')).length).toBeGreaterThan(1);
    await page.waitForTimeout(100);
    // Same answer: the very same rows
    await expect(body.locator('button.cal-row[data-kept="1"]')).toHaveCount(1);
});

test("calendar: another chat never shows the previous chat's list while its own loads", async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    await expect(body.locator('button.cal-row')).toHaveCount(2);
    let release = () => {};
    const hold = new Promise((resolve) => (release = resolve));
    await page.route('**/calendar', async (route) => {
        await hold;
        await route.fallback();
    });
    await openProfilePage(page, 'my-profile');
    await page.locator('#my-profile-body .chat-row', { hasText: 'Киноклуб' }).click();
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    await expect(body.locator('[aria-busy="true"]')).toHaveCount(1);
    await expect(body.locator('button.cal-row')).toHaveCount(0);
    release();
    await expect(body.locator('button.cal-row')).toHaveCount(2);
    await expect(body.locator('[aria-busy="true"]')).toHaveCount(0);
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
    await expect(card.locator('.tc-rating use')).toHaveAttribute('href', '#i-star');
    await expect(card.getByRole('link', { name: 'Open on Kinopoisk' })).toHaveAttribute(
        'href',
        'https://www.kinopoisk.ru/series/1/'
    );
});

test('calendar: a film card counts down, expands its description and leaves missing data out', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.calendar.items
        .filter((item) => item.kind === 'movie' && item.overview)
        .forEach((item) => {
            item.overview = 'A long calendar overview. '.repeat(100);
        });
    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    await body.getByRole('tab', { name: 'Films', exact: true }).click();
    await body.locator('button.cal-row', { hasText: 'Дюна: Часть третья' }).click();
    const card = page.locator('#mine-card-modal');
    await expect(card.locator('.tc-date-value')).toHaveText(['6 Nov 2026 · Belgium', 'Date unknown']);
    await expect(card.locator('.tc-date-when')).toHaveText('in 2 days');
    await expect(card.locator('.tc-rating')).toContainText('7.4');
    const clamped = () =>
        card
            .locator('.tc-more')
            .getAttribute('aria-expanded')
            .then((value) => value === 'false');
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

test('digital release notifications are off by default and can be enabled', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-settings');
    const toggle = page.getByRole('switch', { name: 'Digital releases', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(panel.account.sent.find((r) => r.method === 'PATCH').body).toEqual({ notify_digital: true });
});

test('signing out, or a session that ends, brings back the sign-in screen', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    await expect(page.locator('#my-subs-body button.title-row')).toHaveCount(2);
    panel.account.signedIn = false;
    await openMine(page, 'my-calendar');
    await expect(page.locator('#login-gate')).toBeVisible();
    await expect(page.locator('#login-error')).toContainText('Your session has ended');
});

test('on a phone a user has four tabs, big enough to tap, and nothing scrolls sideways', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone layout');
    await mockPanel(page, { role: 'user' });
    await expect(page.locator('#my-calendar-body button.cal-row')).toHaveCount(2);
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
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
    await expect(body.locator('.chat-row', { hasText: 'Киноклуб' })).toHaveAttribute('aria-pressed', 'true');
    await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');

    await openProfilePage(page, 'my-profile');
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

test('groups Telegram did not answer for: the Account tab says so, and Retry brings them back', async ({ page }) => {
    const panel = await mockPanel(page, {
        role: 'user',
        chatsPartial: 1,
        hiddenGroups: [{ id: '-200', type: 'group', title: 'Сериальная', settings: false }]
    });
    await openProfilePage(page, 'my-profile');
    const body = page.locator('#my-profile-body');
    const retry = body.locator('[data-action="chats-retry"]');
    await expect(retry).toContainText("Some groups didn't load");
    await expect(retry).toContainText('Retry');
    await expect(body.locator('.chat-row')).not.toContainText(['Сериальная']);
    const open = await body.locator('.chat-row[aria-pressed="true"]').getAttribute('data-id');
    await retry.click();
    await expect(body.locator('.chat-row', { hasText: 'Сериальная' })).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.path === '/api/account/chats?fresh=1')).toBe(true);
    // Only the list changed: the open chat stays open
    await expect(body.locator('.chat-row[aria-pressed="true"]')).toHaveAttribute('data-id', open);
});

test('a Retry that fails again keeps the open group open and listed', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', chatsPartial: 2 });
    await openProfilePage(page, 'my-profile');
    const body = page.locator('#my-profile-body');
    await body.locator('.chat-row', { hasText: 'Киноклуб' }).click();
    await openProfilePage(page, 'my-profile');
    // Telegram doesn't answer for the open group this time
    const group = panel.account.chats.findIndex((c) => c.title === 'Киноклуб');
    const [missing] = panel.account.chats.splice(group, 1);
    await body.locator('[data-action="chats-retry"]').click();
    await expect(body.locator('[data-action="chats-retry"]')).toContainText('Retry');
    await expect(body.locator('.chat-row[aria-pressed="true"]')).toContainText('Киноклуб');
    panel.account.chats.push(missing);
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

test('the header opens Account without a chevron; the chosen chat shows on every page', async ({ page, isMobile }) => {
    const panel = await mockPanel(page, { role: 'user' });
    const chip = profileButton(page, 'my-calendar');
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
    await expect(page.locator('#my-profile-section')).toHaveClass(/active/);
    await expect(chip.locator('use[href$="#chevron-down"]')).toHaveCount(0);
    await expect(chip).toHaveAttribute('href', '#my-profile');
    await expect(page.locator('#pick-modal')).toBeHidden();
    const rows = page.locator('#my-profile-body [data-action="profile-chat"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Private chat');
    await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toContainText('Group · view only');
    await rows.nth(1).click();
    await expect(page.locator('#pick-modal')).toBeHidden();
    await expect(page.locator('#my-calendar-section')).toHaveClass(/active/);
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
    await expect(body.locator('.group-row .row-tile svg use').first()).toHaveAttribute('href', '#i-moon');
    await expect(body.locator('.group-row-static .row-meta')).toHaveText([
        'Also notify about the digital release',
        'Mondays at 10:00',
        'On the 1st at 10:00'
    ]);
    for (const title of await body.locator('.group-title').all())
        expect(await title.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');

    await body.locator('[data-action="mine-pick"][data-name="quiet"]').click();
    const sheet = page.locator('#pick-modal');
    await expect(sheet).toHaveClass(/app-sheet/);
    await expect(sheet.locator('.sheet-grabber')).toHaveCount(1);
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
    await expect(page.locator('#login-step')).toHaveText('Sign in with password');
    await expect(page.locator('.login-lead')).toHaveText('Works if you’ve set a password in Account settings.');
    const name = page.getByLabel('Telegram username or ID');
    await expect(name).toHaveAttribute('placeholder', '@username or ID');
    await expect(name).toHaveAttribute('autocomplete', 'username');
    await expect(name).toHaveAttribute('autocapitalize', 'none');
    await expect(name).toHaveAttribute('spellcheck', 'false');
    await expect(page.locator('#login-pass')).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.locator('.login-note')).toHaveText(
        'Forgot it? Sign in with Telegram and set a new one in Account settings.'
    );
    const submit = page.locator('form[data-login="password"] [type="submit"]');
    await expect(submit).toHaveText('Sign in');
    // Off until both fields are filled
    await expect(submit).toBeDisabled();
    await name.fill('@me');
    await expect(submit).toBeDisabled();
    await page.locator('#login-pass').fill('x');
    await expect(submit).toBeEnabled();
    await page.locator('#login-pass').fill('');
    await expect(submit).toBeDisabled();
    // The fields' edges on the button's
    const edges = await page.evaluate(() =>
        ['#login-pass', 'form[data-login="password"] [type="submit"]'].map((sel) => {
            const box = document.querySelector(sel).closest('.password-input, button').getBoundingClientRect();
            return [Math.round(box.left), Math.round(box.right)];
        })
    );
    expect(edges[0]).toEqual(edges[1]);
    const eye = page.locator('.login-form [data-action="password-show"]');
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
            size: [toggle.width, toggle.height],
            border: getComputedStyle(button).borderWidth
        };
    });
    expect(layout).toEqual({ inside: true, right: true, size: [44, 44], border: '0px' });
    expect(panel.account.sent.filter((r) => r.path === '/api/login/password')).toHaveLength(0);

    await page.locator('#login-pass').fill('wrong-one');
    await submit.click();
    const error = page.locator('#login-pass-error');
    await expect(error).toHaveText('Wrong username or password.');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.locator('#login-pass')).toHaveValue('');
    await expect(page.locator('#login-pass')).toBeFocused();
    await expect(submit).toBeDisabled();

    await page.locator('#login-pass').fill('too-many');
    await page.locator('#login-pass').press('Enter');
    await expect(error).toHaveText('Too many attempts. Try again in 15 minutes.');

    // The eye shows what is typed
    await page.locator('#login-pass').fill('good-password');
    const eyeSvg = await eye.locator('svg').elementHandle();
    await eye.click();
    await expect(page.locator('#login-pass')).toHaveAttribute('type', 'text');
    expect(await eyeSvg.evaluate((svg) => svg.isConnected)).toBe(true);
    await expect(eye.locator('.password-eye-slash')).toHaveCSS('opacity', '0');
    await expect(eye).toHaveAttribute('aria-label', 'Hide password');
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    await eye.click();
    await expect(page.locator('#login-pass')).toHaveAttribute('type', 'password');
    await expect(eye.locator('path')).toHaveAttribute('d', 'm3 3 18 18');
    expect(await eyeSvg.evaluate((svg) => svg.isConnected)).toBe(true);
    await expect(eye.locator('.password-eye-slash')).toHaveCSS('opacity', '1');
    await expect(eye).toHaveAttribute('aria-label', 'Show password');
    panel.account.confirmationState = 'waiting';
    await submit.click();
    // A personal account confirms in Telegram
    await expect(page.locator('#login-step')).toHaveText('Confirm in Telegram');
    await expect(page.locator('.login-lead')).toHaveText(
        'We sent a message to your NotFckBot chat. Tap «Да, это я» there to finish signing in.'
    );
    await expect(page.locator('#login-digits .login-digits-value')).toHaveText('042 719');
    await expect(page.locator('#login-status')).toContainText('Waiting for confirmation…');
    await expect(page.locator('.login-expand')).toHaveCount(0);
    expect(panel.account.signedIn).toBe(false);
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
    expect(panel.account.sent.filter((r) => r.path === '/api/login/password').at(-1).body).toEqual({
        login: '@me',
        password: 'good-password'
    });
});

test('a sent password shows loading and cannot be sent twice', async ({ page }) => {
    let answer;
    const held = new Promise((resolve) => (answer = resolve));
    const panel = await mockPanel(page, { signedOut: true, system: true, passwordWait: () => held });
    await page.locator('[data-action="login-password"]').click();
    await page.locator('#login-name').fill('admin');
    await page.locator('#login-pass').fill('good-password');
    const submit = page.locator('form[data-login="password"] [type="submit"]');
    await submit.click();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(submit).toBeDisabled();
    await expect(submit.locator('.login-spin')).toBeVisible();
    await page.locator('#login-pass').press('Enter');
    answer();
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.sent.filter((r) => r.path === '/api/login/password')).toHaveLength(1);
});

test('QR code: the same digits as Telegram, and leaving cancels the pending attempt', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'waiting';
    await page.locator('[data-action="login-qr"]:enabled').click();
    await expect(page.locator('#login-step')).toHaveText('Scan the QR code');
    const qr = page.getByRole('img', { name: 'QR code for signing in' });
    await expect(qr.locator('img')).toBeVisible();
    expect((await qr.boundingBox()).width).toBe(232);
    await expect(page.locator('#login-digits')).toContainText('The bot will show 042 719');
    await expect(page.locator('#login-timer')).toHaveText(/^Code expires in [45]:\d\d$/);
    await expect(page.getByRole('link', { name: 'Open Telegram on this device' })).toHaveAttribute('href', /t\.me/);
    expect(panel.account.signedIn).toBe(false);
    // New code: a new one, the old one cancelled
    await page.locator('[data-action="login-renew-qr"]').click();
    await expect.poll(() => panel.account.sent.filter((r) => r.path === '/api/login/telegram').length).toBe(2);
    await expect(page.locator('#login-step')).toHaveText('Scan the QR code');
    await page.getByRole('button', { name: 'Use another way' }).click();
    await expect(page.locator('[data-action="login-password"]')).toBeVisible();
    await expect
        .poll(() => panel.account.sent.filter((r) => r.path === '/api/login/telegram/cancel').length)
        .toBeGreaterThanOrEqual(2);
    await page.locator('[data-action="login-qr"]:enabled').click();
    panel.account.confirmationState = 'in';
    await expect(page.locator('#login-gate')).toBeHidden({ timeout: 10000 });
});

test('a QR renews itself before it ends, on a phone as on a computer', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true, codeLife: 8000 });
    panel.account.confirmationState = 'waiting';
    // The QR opens from its tile, on a phone as on a computer
    await page.locator('[data-action="login-qr"]:enabled').click();
    const qr = page.getByRole('img', { name: 'QR code for signing in' }).locator('img');
    await expect(qr).toBeVisible();
    const asked = panel.account.sent.filter((r) => r.path === '/api/login/telegram').length;
    await expect
        .poll(() => panel.account.sent.filter((r) => r.path === '/api/login/telegram').length, { timeout: 8000 })
        .toBeGreaterThan(asked);
    // Still the QR, no "time ran out", and the old code cancelled
    await expect(qr).toBeVisible();
    await expect(page.locator('.login-status.is-ended')).toHaveCount(0);
    expect(panel.account.sent.some((r) => r.path === '/api/login/telegram/cancel')).toBe(true);
});

test('a cancelled or expired wait stays on its screen and offers a new try', async ({ page }) => {
    const panel = await mockPanel(page, { signedOut: true });
    for (const [state, text, again] of [
        ['refused', 'Sign-in was cancelled in the bot.', 'Try again'],
        ['gone', 'The code has expired.', 'New code']
    ]) {
        panel.account.confirmationState = state;
        await page.locator('[data-action="login-code"]:enabled').click();
        const status = page.locator('#login-status');
        await expect(status).toHaveText(text, { timeout: 10000 });
        await expect(status).toHaveAttribute('role', 'status');
        await expect(page.locator('#login-digits')).toHaveCSS('opacity', '0.4');
        await expect(page.locator('#login-command')).toHaveCount(0);
        const button = page.locator('#login-actions .btn');
        await expect(button).toHaveText(again);
        // Focus stays on Back where the way's screen put it
        await expect(page.getByRole('button', { name: 'Use another way' })).toBeVisible();
        expect(panel.account.signedIn).toBe(false);
        const asked = panel.account.sent.filter((r) => r.path === '/api/login/telegram').length;
        panel.account.confirmationState = 'waiting';
        await button.click();
        await expect(page.locator('#login-status')).toContainText('Waiting for the bot…');
        expect(panel.account.sent.filter((r) => r.path === '/api/login/telegram')).toHaveLength(asked + 1);
        await page.locator('#login-back').click();
    }
});

test('a confirmation that ran out says so on the Telegram screen', async ({ page, context }) => {
    const panel = await mockPanel(page, { signedOut: true });
    panel.account.confirmationState = 'gone';
    const popup = context.waitForEvent('page');
    await page.locator('#login-tg[href]').click();
    await (await popup).close();
    await expect(page.locator('#login-status')).toHaveText('The time to confirm has run out.', { timeout: 10000 });
    await expect(page.locator('#login-actions .btn')).toHaveText('Try again');
    await expect(page.locator('.login-expand')).toHaveCount(0);
});

test('the system password bypasses Telegram; deliberate panel use renews activity once per minute', async ({
    page
}) => {
    const panel = await mockPanel(page, { signedOut: true, system: true });
    await page.locator('[data-action="login-password"]').click();
    await page.locator('#login-name').fill('admin');
    await page.locator('#login-pass').fill('good-password');
    await page.locator('form[data-login="password"] [type="submit"]').click();
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('#login-status')).toHaveCount(0);
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
    await expect(page.locator('[data-section="my-aired"] use').first()).toHaveAttribute('href', '#i-clapperboard');
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
            chipRight: Math.round(
                document.querySelector('#my-subs-section header').getBoundingClientRect().right - chip.right
            ),
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

test('a waiting film shows Release and digital information, with the main bell on Release', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openMine(page, 'my-subs');
    await page.locator('#my-subs-body [role="tab"]', { hasText: 'Films' }).click();
    const row = page.locator('#my-subs-body button.title-row', { hasText: 'Дюна: Часть третья' });
    await expect(row.locator('.row-meta')).toHaveText('Release Nov 6, 2026 · Belgium');
    await row.click();
    const dates = page.locator('#mine-card-modal .tc-date');
    await expect(dates).toHaveCount(2);
    await expect(dates.nth(0).locator('.tc-date-label').first()).toHaveText('Release');
    await expect(dates.nth(0).locator('.tc-date-value')).toHaveText('6 Nov 2026 · Belgium');
    await expect(dates.nth(0)).toContainText('In Russia 18 Feb 2027');
    await expect(dates.nth(0).locator('.tc-bell')).toHaveCount(1);
    await expect(dates.nth(1).locator('.tc-date-value')).toHaveText('Date unknown');
    await expect(dates.nth(1).locator('.tc-date-label').first()).toHaveText('Digital release');
    await expect(dates.nth(1).locator('.tc-bell')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await openMine(page, 'my-calendar');
    const body = page.locator('#my-calendar-body');
    await body.getByRole('tab', { name: 'Films', exact: true }).click();
    await expect(body.locator('button.cal-row', { hasText: 'Дюна: Часть третья' }).locator('.row-meta')).toHaveText(
        'Release · Belgium'
    );
    await expect(body.locator('button.cal-row', { hasText: 'Мегалополис' }).locator('.row-meta')).toHaveText(
        'Release · United States'
    );
});
