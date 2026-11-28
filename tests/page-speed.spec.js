const { test, expect } = require('@playwright/test');
const { watchConsole } = require('./helpers');
const { mockPanel } = require('./mock-panel');
const { openSection } = require('./helpers');

test.describe('page loading', () => {
    watchConsole();

    test('table refresh waits for its response and ignores an older answer', async ({ page }) => {
        await mockPanel(page, { path: '/#chats' });
        await expect(page.locator('#chats-section')).toContainText('alice');
        await page.evaluate(async () => {
            const data = await import('/js/data.js');
            const original = window.fetch;
            window.tableRequests = [];
            window.fetch = (url, options) =>
                String(url) === '/api/data/chats'
                    ? new Promise((resolve) =>
                          window.tableRequests.push((rows) => resolve(new Response(JSON.stringify(rows))))
                      )
                    : original(url, options);
            window.firstSettled = false;
            window.firstRefresh = data.fetchData().then(() => {
                window.firstSettled = true;
            });
            window.secondRefresh = data.fetchData();
        });
        expect(await page.evaluate(() => window.firstSettled)).toBe(false);
        await page.evaluate(async () => {
            const row = (name) => [{ id: 101, username: name, type: 'private', bot_status: 'active' }];
            window.tableRequests[1](row('Fresh answer'));
            await window.secondRefresh;
            window.tableRequests[0](row('Old answer'));
            await window.firstRefresh;
        });
        await expect(page.locator('#chats-section')).toContainText('Fresh answer');
        await expect(page.locator('#chats-section')).not.toContainText('Old answer');
    });

    for (const language of ['en', 'ru']) {
        test(`built personal ${language} page loads no admin module, charts or external fonts`, async ({ page }) => {
            const requests = [];
            page.on('request', (request) => requests.push(request.url()));
            await mockPanel(page, { built: true, role: 'user', language, path: '/#my-calendar' });
            await expect(page.locator('#my-calendar-section')).toBeVisible();
            await expect(page.locator('#my-calendar-body .skeleton')).toHaveCount(0);
            const assets = requests.filter((url) => url.includes('/assets/'));
            expect(assets.length).toBeGreaterThan(0);
            expect(assets.some((url) => /\/admin-|\/chart-/.test(url))).toBe(false);
            expect(requests.some((url) => /fonts\.google/.test(url))).toBe(false);
        });
    }

    test('built admin navigation loads charts only on Dashboard and retains settings actions', async ({ page }) => {
        const requests = [];
        page.on('request', (request) => requests.push(request.url()));
        await mockPanel(page, { built: true, path: '/#chats' });
        await expect(page.locator('#chats-section')).toContainText('alice');
        expect(requests.some((url) => /\/chart-/.test(url))).toBe(false);
        await openSection(page, 'dashboard');
        await expect.poll(() => page.evaluate(() => Boolean(window.Chart?.getChart('chart-subs')))).toBe(true);
        expect(requests.filter((url) => /\/chart-/.test(url))).toHaveLength(1);
        await openSection(page, 'settings');
        await expect(page.locator('#settings-section')).toContainText('Connections');
    });

    test('Chart.js retries an unsuccessful load even when the chart data did not change', async ({ page }) => {
        const files = { 'vendor/chart.umd.js': 'missing' };
        let asked = 0;
        page.on('request', (request) => {
            if (request.url().endsWith('/vendor/chart.umd.js')) asked++;
        });
        await mockPanel(page, { files });
        await expect.poll(() => asked).toBe(1);
        await expect(page.locator('script[src="vendor/chart.umd.js"]')).toHaveCount(0);
        expect(page.__errors.every((message) => message === 'Failed to load resource: net::ERR_FAILED')).toBe(true);
        expect(page.__errors.length).toBeLessThanOrEqual(1);
        page.__errors.length = 0;
        files['vendor/chart.umd.js'] = null;
        await page.evaluate(async () => {
            await (await import('/js/data.js')).fetchData();
        });
        await expect.poll(() => page.evaluate(() => Boolean(window.Chart?.getChart('chart-subs')))).toBe(true);
        expect(asked).toBe(2);
    });
});

test.describe('signed-out documents', () => {
    watchConsole({ ignore: /401 \(Unauthorized\)/ });
    test('saved auto-refresh never loads admin code while signed out', async ({ page }) => {
        await page.clock.install();
        await page.addInitScript(() => localStorage.setItem('admin.autoRefresh', 'on'));
        const requests = [];
        page.on('request', (request) => requests.push(new URL(request.url()).pathname));
        await mockPanel(page, { signedOut: true });
        await page.clock.runFor(11000);
        await page.waitForLoadState('networkidle');
        expect(requests.filter((url) => url === '/js/admin.js' || /^\/api\/(stats|health)/.test(url))).toEqual([]);
    });
    for (const language of ['en', 'ru']) {
        test(`built ${language} Privacy describes local fonts and keeps separate document dates`, async ({ page }) => {
            await mockPanel(page, {
                built: true,
                signedOut: true,
                termsUnchecked: true,
                path: `/?panelLanguage=${language}`
            });
            await page.locator('[data-action="login-privacy"]').click();
            await expect(page.locator('.legal-meta')).toContainText(
                language === 'ru' ? '28 ноября 2026' : '28 November 2026'
            );
            await expect(page.locator('#login-body')).toContainText(
                language === 'ru'
                    ? 'Загрузка шрифтов не отправляет запросы в Google Fonts.'
                    : 'Loading fonts does not send requests to Google Fonts.'
            );
            await page.locator('[data-action="login-cancel"]').click();
            await page.locator('[data-action="login-terms"]').click();
            await expect(page.locator('.legal-meta')).toContainText(
                language === 'ru' ? '18 ноября 2026' : '18 November 2026'
            );
        });
    }
});
