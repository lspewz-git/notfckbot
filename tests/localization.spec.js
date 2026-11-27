const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openProfilePage, openSection } = require('./helpers');

watchConsole();

test('browser language selects Russian, including account settings and navigation', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { value: ['ru-RU'] }));
    await mockPanel(page, { role: 'user', path: '/#my-account' });
    await openProfilePage(page, 'my-account');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('#my-account-section h1')).toHaveText('Настройки аккаунта');
    await expect(page.locator('[data-action="account-language"]')).toContainText('Автоматически');
    await page.locator('[data-action="account-language"]').click();
    await expect(page.locator('#pick-list')).toContainText('язык браузера');
    await expect(page.locator('#pick-list [data-index="0"]')).toHaveAttribute('aria-selected', 'true');
});

test('unsupported browser language falls back to English', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { value: ['fr-FR'] }));
    await mockPanel(page, { role: 'user', path: '/#my-account' });
    await openProfilePage(page, 'my-account');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#my-account-section h1')).toHaveText('Account settings');
});

test('saved account language overrides browser language on a fresh device', async ({ page }) => {
    await mockPanel(page, { role: 'user', language: 'ru', path: '/#my-account' });
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('#my-account-section h1')).toHaveText('Настройки аккаунта');
    await expect(page.locator('[data-action="account-language"]')).toContainText('Русский');
    await expect(page.locator('#my-preferences .group-help')).toHaveText('Выбран русский. Сохранено в аккаунте.');
});

test('account picker persists English and can restore automatic Russian', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { value: ['ru'] }));
    const panel = await mockPanel(page, { role: 'user', path: '/#my-account' });
    await openProfilePage(page, 'my-account');
    await page.locator('[data-action="account-language"]').click();
    await page.locator('#pick-list [data-index="1"]').click();
    await expect(page.locator('#my-account-section h1')).toHaveText('Account settings');
    await expect(page.locator('#my-preferences .group-help')).toHaveText('English is selected. Saved in your account.');
    expect(panel.account.language).toBe('en');
    await page.reload();
    await expect(page.locator('[data-action="account-language"]')).toContainText('English');
    await page.locator('[data-action="account-language"]').click();
    await page.locator('#pick-list [data-index="0"]').click();
    await expect(page.locator('#my-account-section h1')).toHaveText('Настройки аккаунта');
    expect(panel.account.language).toBe('auto');
    await expect(page.locator('#my-preferences .group-help')).toHaveText('По языку Telegram или браузера.');
});

test('native Telegram language wins over browser and survives cleared launch fragment', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'languages', { value: ['en-US'] });
        window.TelegramWebviewProxy = { postEvent() {} };
    });
    const launch = new URLSearchParams({ user: JSON.stringify({ language_code: 'ru' }) }).toString();
    await mockPanel(page, { role: 'user', path: `/#tgWebAppData=${encodeURIComponent(launch)}`, miniAppData: launch });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});

test('a Telegram-looking browser URL cannot change the browser language', async ({ page }) => {
    const launch = new URLSearchParams({ user: JSON.stringify({ language_code: 'ru' }) }).toString();
    await mockPanel(page, { role: 'user', path: `/#tgWebAppData=${encodeURIComponent(launch)}` });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#login-gate')).toBeHidden();
});

test('Russian plural forms and English fallback preserve substitutions', async ({ page }) => {
    await mockPanel(page, { role: 'user', language: 'ru' });
    await expect(page.locator('#login-gate')).toBeHidden();
    const labels = await page.evaluate(async () => {
        const { t } = await import('/js/i18n.js');
        return [1, 2, 5, 21]
            .map((count) => t('{{count}} season', { count }))
            .concat(t('Unknown English phrase {{value}}', { value: 7 }));
    });
    expect(labels).toEqual(['1 сезон', '2 сезона', '5 сезонов', '21 сезон', 'Unknown English phrase 7']);
});

test('saved language works when browser storage is unavailable', async ({ page }) => {
    await page.addInitScript(() =>
        Object.defineProperty(window, 'localStorage', {
            get() {
                throw new DOMException('Blocked', 'SecurityError');
            }
        })
    );
    await mockPanel(page, { role: 'user', language: 'ru', path: '/#my-account' });
    await expect(page.locator('#my-account-section')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.reload();
    await expect(page.locator('#my-account-section')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});

test('failed save keeps the previous language and lets the user retry', async ({ page }) => {
    await mockPanel(page, { role: 'user', languageSaveError: true, path: '/#my-account' });
    await page.locator('[data-action="account-language"]').click();
    await page.locator('#pick-list [data-index="2"]').click();
    await expect(page.locator('.toast')).toContainText('Could not save the language');
    await expect(page.locator('[data-action="account-language"]')).toBeEnabled();
    await expect(page.locator('[data-action="account-language"]')).toContainText('Automatic');
    expect(page.__errors.filter((message) => !/500/.test(message))).toEqual([]);
    page.__errors = [];
});

test('English card loads catalog copy and keeps user titles unchanged', async ({ page }) => {
    const panel = await mockPanel(page, {
        role: 'user',
        contentText: () => ({ overview: 'A journey across the desert.', genres: 'Drama' })
    });
    Object.assign(panel.account.series[0], {
        title: 'Русское название',
        overview: 'Описание на русском',
        genres: 'Драма'
    });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    await expect(page.locator('#mine-card-body h2')).toHaveText('Русское название');
    await expect(page.locator('#mine-card-body .tc-copy')).toHaveText('A journey across the desert.');
    await expect(page.locator('#mine-card-body .tc-genres')).toHaveText('Drama');
});

test('an older catalog reply cannot overwrite the next title card', async ({ page }) => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const panel = await mockPanel(page, {
        role: 'user',
        contentText: async ({ path }) => {
            if (path.endsWith('/100')) {
                await held;
                return { overview: 'Old description', genres: 'Drama' };
            }
            return { overview: '<b>New description</b>', genres: 'Comedy' };
        }
    });
    Object.assign(panel.account.series[0], { overview: 'Первое описание' });
    Object.assign(panel.account.series[1], { overview: 'Второе описание' });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    await expect(page.locator('#mine-card-body .tc-copy')).toHaveText('Loading description…');
    await page.locator('#mine-card-modal [data-close="mine-card-modal"]').click();
    await page.locator('#my-subs-body .title-row').nth(1).click();
    await expect(page.locator('#mine-card-body .tc-copy')).toHaveText('<b>New description</b>');
    release();
    await expect(page.locator('#mine-card-body .tc-copy')).toHaveText('<b>New description</b>');
    await expect(page.locator('#mine-card-body .tc-copy b')).toHaveCount(0);
});

test('a cold card cache still loads the selected-language description', async ({ page }) => {
    const panel = await mockPanel(page, {
        role: 'user',
        contentText: () => ({ overview: 'Fresh English description', genres: 'Drama' })
    });
    Object.assign(panel.account.series[0], { overview: '', genres: null });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    await expect(page.locator('#mine-card-body .tc-copy')).toHaveText('Fresh English description');
});

test('a language reload preserves a Telegram notification target and consumes it once', async ({ page }) => {
    await page.addInitScript(() => (window.TelegramWebviewProxy = { postEvent() {} }));
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'ru',
        miniAppChat: '-100',
        miniAppTitle: 'tv_100',
        path: '/#' + new URLSearchParams({ tgWebAppData: 'auth_date=123&hash=test' })
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await expect(page.locator('#mine-card-body h2')).toHaveText('Одни из нас');
    await expect(page.locator('#my-subs-section [data-chat-picker]')).toContainText('Киноклуб');
    expect(panel.account.sent.filter((request) => request.path === '/api/login/miniapp')).toHaveLength(1);
    await page.locator('#mine-card-modal [data-close="mine-card-modal"]').click();
    await page.reload();
    await expect(page.locator('#mine-card-modal')).toBeHidden();
    expect(page.url()).not.toContain('panelLaunch');
});

for (const language of ['en', 'ru']) {
    test(`${language}: failed catalog copy leaves no permanent loading placeholder`, async ({ page }) => {
        const panel = await mockPanel(page, {
            role: 'user',
            language,
            contentText: () => ({ status: 503, body: { error: 'Catalog temporarily unavailable' } })
        });
        Object.assign(panel.account.series[0], { overview: '', genres: null });
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body .title-row').first().click();
        await expect(page.locator('#mine-card-body .tc-copy')).toHaveText(
            language === 'ru' ? 'Описание недоступно' : 'Description unavailable'
        );
        await expect(page.locator('#mine-card-body [data-loading-copy]')).toHaveCount(0);
        expect(page.__errors.filter((message) => !/503/.test(message))).toEqual([]);
        page.__errors = [];
    });
}

for (const response of ['failed', 'empty']) {
    test(`English fallback description survives ${response} catalog enrichment`, async ({ page }) => {
        const panel = await mockPanel(page, {
            role: 'user',
            language: 'en',
            contentText: () =>
                response === 'failed'
                    ? { status: 503, body: { error: 'Catalog temporarily unavailable' } }
                    : { overview: '', genres: 'Drama' }
        });
        const overview = 'An English TVmaze summary that is already available.';
        Object.assign(panel.account.series[0], {
            overview,
            genres: response === 'failed' ? 'Драма' : 'Drama',
            source: { label: 'TVmaze', url: 'https://www.tvmaze.com/shows/1' }
        });
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body .title-row').first().click();
        await expect(page.locator('#mine-card-body .tc-scroll')).toHaveAttribute(
            'data-localized',
            response === 'failed' ? 'failed' : 'done'
        );
        await expect(page.locator('#mine-card-body .tc-copy')).toHaveText(overview);
        await expect(page.locator('#mine-card-body .tc-genres')).toHaveText('Drama');
        expect(page.__errors.filter((message) => !/503/.test(message))).toEqual([]);
        page.__errors = [];
    });
}

test('Russian recap confirmation translates chat counts and their plural forms', async ({ page }) => {
    const panel = await mockPanel(page, { language: 'ru' });
    await openSection(page, 'recap');
    for (const [count, noun] of [
        [1, 'чат'],
        [2, 'чата'],
        [5, 'чатов'],
        [21, 'чат']
    ]) {
        panel.recap.audience.eligible = count;
        await page.locator('#recap-section [data-action="recap-send-open"]').click();
        const send = page.locator('#recap-send-body [data-action="recap-send-all"]');
        await expect(send).toHaveText(`Отправить: ${count} ${noun}`);
        await send.click();
        await expect(page.locator('#confirm-title')).toHaveText(
            `Отправить итоги ${new Date().getFullYear()} года: ${count} ${noun}?`
        );
        await page.locator('#modal-cancel-btn').click();
        await page.locator('#recap-send-modal [data-close="recap-send-modal"]').first().click();
    }
    expect(panel.recapSends).toBeUndefined();
});

for (const [amount, delay, unit] of [
    [21, 21 * 86400000, 'день'],
    [2, 2 * 3600000, 'часа'],
    [1, 60000, 'минута']
]) {
    test(`Russian scheduled recap translates ${amount} ${unit} countdown`, async ({ page }) => {
        const now = Date.parse('2026-12-15T09:00:00Z');
        await page.clock.setFixedTime(now);
        const firstAt = new Date(now + delay).toISOString();
        await mockPanel(page, {
            language: 'ru',
            recapSchedule: { on: true, day: firstAt.slice(0, 10), hour: 12, firstAt, lastAt: firstAt }
        });
        await openSection(page, 'recap');
        await page.locator('#recap-section [data-tab="schedule"]').click();
        await expect(page.locator('.recap-sched-count b')).toHaveText(String(amount));
        await expect(page.locator('.recap-sched-count span')).toHaveText(`${unit} до первого чата`);
    });
}

test('Russian dashboard translates the busy update check button', async ({ page }) => {
    await mockPanel(page, { language: 'ru' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('#login-gate')).toBeHidden();
    await openSection(page, 'dashboard');
    await page.locator('#run-check').click();
    await expect(page.locator('#run-check')).toBeDisabled();
    await expect(page.locator('#run-check')).toHaveText('Выполняется…');
});
