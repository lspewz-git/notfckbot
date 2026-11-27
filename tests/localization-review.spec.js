const { test, expect } = require('@playwright/test');
const { mockPanel, chatStats } = require('./mock-panel');
const { watchConsole, openSection, openProfilePage } = require('./helpers');

watchConsole();

test('native automatic language survives reload and manual choices with both storage APIs blocked', async ({
    page
}) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'languages', { value: ['en-US'] });
        window.TelegramWebviewProxy = { postEvent() {} };
        for (const storage of ['localStorage', 'sessionStorage'])
            Object.defineProperty(window, storage, {
                get() {
                    throw new DOMException('Blocked', 'SecurityError');
                }
            });
    });
    const launch = new URLSearchParams({ user: JSON.stringify({ language_code: 'ru' }) }).toString();
    const panel = await mockPanel(page, {
        role: 'user',
        path: `/#tgWebAppData=${encodeURIComponent(launch)}`,
        miniAppData: launch
    });
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.reload();
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await openProfilePage(page, 'my-account');
    await page.locator('[data-action="account-language"]').click();
    await page.locator('#pick-list [data-index="1"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#login-gate')).toBeHidden();
    await page.locator('[data-action="account-language"]').click();
    await page.locator('#pick-list [data-index="0"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('#login-gate')).toBeHidden();
    expect(panel.account.language).toBe('auto');
    expect(page.url()).not.toMatch(/tgWebAppData|auth_date|language_code/);
});

test('a browser ignores the cosmetic Telegram-language hint', async ({ page }) => {
    await mockPanel(page, { role: 'user', path: '/?telegramLanguage=ru#my-account' });
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('fresh native language overrides an older cosmetic hint', async ({ page }) => {
    await page.addInitScript(() => {
        window.TelegramWebviewProxy = { postEvent() {} };
        Object.defineProperty(navigator, 'languages', { value: ['ru-RU'] });
    });
    const launch = new URLSearchParams({ user: JSON.stringify({ language_code: 'en' }) }).toString();
    await mockPanel(page, {
        role: 'user',
        path: `/?telegramLanguage=ru#tgWebAppData=${encodeURIComponent(launch)}`,
        miniAppData: launch
    });
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(page.locator('#login-gate')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

for (const language of ['en', 'ru']) {
    test(`${language}: source genres share one translation in Released, Statistics and primary-source cards`, async ({
        page
    }) => {
        const original = ['драма', 'ДОКУМЕНТАЛЬНЫЙ', 'science fiction', 'Made-up genre'];
        const expected =
            language === 'ru'
                ? ['Драма', 'Документальный', 'Фантастика', 'Made-up genre']
                : ['Drama', 'Documentary', 'Science-Fiction', 'Made-up genre'];
        const panel = await mockPanel(page, {
            language,
            history: () => ({
                years: [2026],
                year: 2026,
                series: [{ tmdbId: 'tv_100', title: 'A series', seasons: [], genres: original }],
                films: [{ tmdbId: 'movie_7', title: 'A film', genres: ['мультфильм', 'телевизионный фильм'] }]
            }),
            chatStats: (query) => {
                const stats = chatStats(query);
                stats.favourites.genres = original.map((name, i) => ({ name, n: 20 - i }));
                return stats;
            }
        });
        Object.assign(panel.account.series[0], {
            genres: original.join(', '),
            source: { label: 'TVmaze', url: 'https://www.tvmaze.com/shows/1' }
        });
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.locator('#login-gate')).toBeHidden();
        await openSection(page, 'history');
        await expect(page.locator('#history-series .history-genres')).toHaveText(expected.join(', '));
        await expect(page.locator('#history-films .history-genres')).toHaveText(
            language === 'ru' ? 'Мультфильм, Телевизионный фильм' : 'Animation, TV Movie'
        );
        await openSection(page, 'chats');
        await page.locator('[data-action="chat-actions"][data-id="-1003"]').click();
        await page.locator('#action-stats').click();
        await expect(
            page.locator('#chat-stats-body .stats-cols-3 .stats-box').first().locator('.stats-name')
        ).toHaveText(expected.slice(0, 3));
        await page.locator('#chat-stats-modal .modal-back').click();
        await expect(page.locator('#chat-stats-modal')).toBeHidden();
        await page.locator('#chat-actions-modal [data-close="chat-actions-modal"]').click();
        await expect(page.locator('#chat-actions-modal')).toBeHidden();
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body [data-id="tv_100"]').click();
        await expect(page.locator('#mine-card-body .tc-genres')).toHaveText(expected.join(', '));
        expect(panel.account.series[0].genres).toBe(original.join(', '));
    });

    test(`${language}: Released page-size choices have complete translated accessible labels`, async ({ page }) => {
        const rows = Array.from({ length: 12 }, (_, i) => ({
            tmdbId: `tv_${i + 1}`,
            title: `Series ${i + 1}`,
            genres: []
        }));
        await mockPanel(page, {
            language,
            history: () => ({
                years: [2026],
                year: 2026,
                series: rows,
                films: rows.map((row, i) => ({ ...row, tmdbId: `movie_${i + 1}` }))
            })
        });
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.locator('#login-gate')).toBeHidden();
        await openSection(page, 'history');
        for (const [kind, label] of [
            ['series', language === 'ru' ? 'Сериалов на странице' : 'Series per page'],
            ['films', language === 'ru' ? 'Фильмов на странице' : 'Films per page']
        ]) {
            const pager = page.locator(`#history-${kind}-pager`);
            await expect(pager.locator('select')).toHaveAttribute('aria-label', label);
            await expect(pager.locator('.custom-select-trigger')).toHaveAttribute('aria-label', `${label}: 10`);
        }
    });
}
