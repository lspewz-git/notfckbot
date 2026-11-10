const { test, expect } = require('@playwright/test');
const { watchConsole, profileButton } = require('./helpers');
const { mockPanel } = require('./mock-panel');

watchConsole({ ignore: /status of (503)|Could not load chats/ });
const path = `/#${new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })}`;

for (const role of ['user', 'admin']) {
    for (const [title, name, tab] of [
        ['tv_100', 'Одни из нас', 'Series'],
        ['tv_300', 'Тед Лассо', 'Ended'],
        ['movie_7', 'Дюна: Часть третья', 'Films']
    ]) {
        test(`notification opens ${title} on group Following (${role})`, async ({ page }) => {
            await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
            const panel = await mockPanel(page, {
                path,
                signedOut: true,
                role,
                miniAppChat: '-100',
                miniAppTitle: title
            });
            await expect(page.locator('#my-subs-section')).toBeVisible();
            await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');
            await expect(page.locator('#mine-card-modal')).toBeVisible();
            await expect(page.locator('#mine-card-modal h2')).toContainText(name);
            await expect(page.locator('#my-subs-section [role="tab"][aria-selected="true"]')).toContainText(tab);
            expect(panel.account.sent.some((r) => r.path.startsWith('/api/account/chats/42/'))).toBe(false);
            await page.locator('#mine-card-modal [data-close="mine-card-modal"]').first().click();
            await expect(page.locator('#my-subs-section')).toBeVisible();
            await expect(page.locator('#mine-card-modal')).not.toBeVisible();
        });
    }
}

test('private notification survives a failed account lookup without replaying launch data', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const panel = await mockPanel(page, {
        path,
        role: 'user',
        miniAppChat: '42',
        miniAppTitle: 'movie_7',
        meFails: [503]
    });
    await page.locator('[data-action="login-retry"]').click();
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await expect(profileButton(page, 'my-subs')).toContainText('My account');
    expect(panel.account.sent.filter((r) => r.path === '/api/login/miniapp')).toHaveLength(1);
});

test('notification retains the source chat and card after the chat list fails and is retried', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const panel = await mockPanel(page, {
        path,
        role: 'user',
        miniAppChat: '-100',
        miniAppTitle: 'tv_100',
        chatsDown: true
    });
    await expect(page.locator('#my-subs-body [data-action="mine-reload"]')).toBeVisible();
    panel.account.chatsDown = false;
    await page.locator('#my-subs-body [data-action="mine-reload"]').click();
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await expect(profileButton(page, 'my-subs')).toContainText('Киноклуб');
});

test('a missing title leaves Following usable without opening a different card', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    await mockPanel(page, { path, role: 'user', miniAppChat: '-100', miniAppTitle: 'movie_999' });
    await expect(page.getByText('This title is no longer followed in this chat.', { exact: true })).toBeVisible();
    await expect(page.locator('#my-subs-section')).toBeVisible();
    await expect(page.locator('#mine-card-modal')).not.toBeVisible();
});

test('an inaccessible source chat never loads the title from the fallback chat', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const panel = await mockPanel(page, { path, role: 'user', miniAppChat: '-999', miniAppTitle: 'movie_7' });
    await expect(page.getByText('This chat is no longer available.', { exact: true })).toBeVisible();
    await expect(page.locator('#mine-card-modal')).not.toBeVisible();
    expect(panel.account.sent.some((r) => r.path.includes('title='))).toBe(false);
});

test('ordinary browser launch data never selects a notification title', async ({ page }) => {
    const panel = await mockPanel(page, { path, role: 'user', miniAppChat: '-100', miniAppTitle: 'movie_7' });
    await expect(page.locator('#my-calendar-section')).toBeVisible();
    await expect(page.locator('#mine-card-modal')).not.toBeVisible();
    expect(panel.account.sent.some((r) => r.path === '/api/login/miniapp')).toBe(false);
});

test('a released film opens its Following card after leaving the waiting list', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const panel = await mockPanel(page, {
        path,
        role: 'user',
        miniAppChat: '-100',
        miniAppTitle: 'movie_8',
        releasedFilms: [{ id: 8, tmdbId: 'movie_8', title: 'Released film', year: 2026, links: [] }]
    });
    await expect(page.locator('#mine-card-modal h2')).toHaveText('Released film');
    await expect(page.locator('#my-subs-section')).toBeVisible();
    expect(panel.account.films.some((f) => f.tmdbId === 'movie_8')).toBe(false);
});
