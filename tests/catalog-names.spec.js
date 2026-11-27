const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, openProfilePage, openActions } = require('./helpers');

watchConsole();

async function trackNames(page) {
    await page.addInitScript(() => {
        window.__catalogNames = [];
        new MutationObserver(() => {
            const node = document.querySelector('#my-subs-body [data-catalog-title="tv_100"]');
            if (node && window.__catalogNames.at(-1) !== node.textContent) window.__catalogNames.push(node.textContent);
        }).observe(document, { childList: true, subtree: true, characterData: true });
    });
}

for (const language of ['en', 'ru'])
    for (const blocked of [false, true]) {
        test(
            language + ': first payload renders one name without browser lookup or storage, blocked=' + blocked,
            async ({ page }) => {
                await trackNames(page);
                await page.addInitScript(
                    ({ language, blocked }) => {
                        if (blocked)
                            Object.defineProperty(window, 'localStorage', {
                                get() {
                                    throw new Error('Blocked');
                                }
                            });
                        else {
                            localStorage.setItem('nfb.language', language);
                            localStorage.setItem(
                                'nfb.catalog-names.v1.' + language,
                                JSON.stringify([['tv_100', 'Stale browser name', Date.now() + 60000]])
                            );
                        }
                    },
                    { language, blocked }
                );
                const panel = await mockPanel(page, { role: 'user', language, titleText: provider });
                const name = language === 'ru' ? 'Локализованное русское название' : 'The Last of Us';
                await openSection(page, 'my-subs');
                const title = page.locator('#my-subs-body [data-catalog-title="tv_100"]');
                await expect(title).toHaveText(name);
                await expect(title).not.toHaveAttribute('aria-busy');
                await expect(title).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
                expect(await page.evaluate(() => window.__catalogNames)).toEqual([name]);
                expect(panel.account.sent.filter((r) => r.path.includes('/account/content/'))).toEqual([]);
                await page.reload();
                await expect(title).toHaveText(name);
                expect(await page.evaluate(() => window.__catalogNames)).toEqual([name]);
                expect(panel.account.sent.filter((r) => r.path.includes('/account/content/'))).toEqual([]);
            }
        );
    }

test('a delayed page response inserts the ready name once and card enrichment never renames it', async ({ page }) => {
    await trackNames(page);
    let releaseNames;
    let releaseCopy;
    const names = new Promise((resolve) => (releaseNames = resolve));
    const copy = new Promise((resolve) => (releaseCopy = resolve));
    await mockPanel(page, {
        role: 'user',
        language: 'en',
        titleText: async (request) => {
            await names;
            return provider(request);
        },
        contentText: async () => {
            await copy;
            return { title: 'Unexpected late name', overview: 'Description', genres: '' };
        }
    });
    await openSection(page, 'my-subs');
    const title = page.locator('#my-subs-body [data-catalog-title="tv_100"]');
    await expect(title).toHaveCount(0);
    releaseNames();
    await expect(title).toHaveText('The Last of Us');
    await page.locator('#my-subs-body [data-id="tv_100"]').click();
    await expect(page.locator('#mine-card-body h2')).toHaveText('The Last of Us');
    releaseCopy();
    await expect(page.locator('#mine-card-body .tc-copy')).toHaveText('Description');
    await expect(page.locator('#mine-card-body h2')).toHaveText('The Last of Us');
    expect(await page.evaluate(() => window.__catalogNames)).toEqual(['The Last of Us']);
});

test('tracked choices are localized when the picker opens and preserve edited fields', async ({ page }) => {
    const panel = await mockPanel(page, { language: 'en', titleText: () => ({ title: 'Catalog title' }) });
    await openSection(page, 'dashboard');
    await openActions(page);
    await page.locator('#test-notify-btn').click();
    await expect(page.locator('#test-notify-modal')).toBeVisible();
    const select = page.locator('#test-notify-series-select');
    const selected = await select.inputValue();
    await expect(select.locator('option').first()).toContainText('Catalog title');
    await page.locator('#test-notify-season').fill('9');
    await page.locator('#test-notify-episode').fill('17');
    await expect(select).toHaveValue(selected);
    await expect(page.locator('#test-notify-season')).toHaveValue('9');
    await expect(page.locator('#test-notify-episode')).toHaveValue('17');
    expect(panel.lastTest).toBeUndefined();
});

const provider = ({ path, language }) => ({
    title: path.endsWith('/100')
        ? language === 'ru'
            ? 'Локализованное русское название'
            : 'The Last of Us'
        : path.endsWith('/7')
          ? language === 'ru'
              ? 'Дюна: Часть третья'
              : 'Dune: Part Three'
          : '',
    overview: language === 'ru' ? 'Описание из каталога.' : 'A catalog description.',
    genres: language === 'ru' ? 'Драма' : 'Drama'
});

for (const language of ['en', 'ru']) {
    test(`${language}: saved titles localize in lists, cards, calendar and Released without changing stored data`, async ({
        page
    }) => {
        const panel = await mockPanel(page, { role: 'user', language, contentText: provider });
        const stored = panel.account.series[0].title;
        const name = language === 'ru' ? 'Локализованное русское название' : 'The Last of Us';
        await openSection(page, 'my-subs');
        await expect(page.locator('#my-subs-body [data-id="tv_100"] .row-name')).toHaveText(name);
        await page.locator('#my-subs-body [data-id="tv_100"]').click();
        await expect(page.locator('#mine-card-body h2')).toHaveText(name);
        await page.locator('#mine-card-body [data-action="mine-ask-unfollow"]').click();
        await expect(page.locator('#confirm-title')).toContainText(name);
        await page.locator('#modal-cancel-btn').click();
        await page.locator('#mine-card-modal [data-close="mine-card-modal"]').click();
        await openSection(page, 'my-calendar');
        await expect(page.locator('#my-calendar-body [data-catalog-title="tv_100"]').first()).toHaveText(name);
        await openSection(page, 'my-aired');
        await expect(page.locator('#my-aired-body [data-catalog-title="tv_100"]').first()).toHaveText(name);
        await openSection(page, 'my-subs');
        await page.locator('[data-action="mine-subs-tab"][data-tab="films"]').click();
        await expect(page.locator('#my-subs-body [data-catalog-title="movie_7"]')).toHaveText(
            language === 'ru' ? 'Дюна: Часть третья' : 'Dune: Part Three'
        );
        expect(panel.account.series[0].title).toBe(stored);
        expect(panel.account.sent.filter((r) => r.method !== 'GET' && r.path.includes('/series'))).toEqual([]);
    });
}

test('changing the account language replaces the title cache after reload', async ({ page }) => {
    await mockPanel(page, { role: 'user', language: 'en', contentText: provider });
    await openSection(page, 'my-subs');
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_100"]')).toHaveText('The Last of Us');
    await openProfilePage(page, 'my-account');
    await page.locator('[data-action="account-language"]').click();
    await page.locator('#pick-list [data-index="2"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await openSection(page, 'my-subs');
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_100"]')).toHaveText(
        'Локализованное русское название'
    );
});

test('localized names are text and the filter matches them without changing chat names', async ({ page }) => {
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: ({ path }) => ({
            title: path.endsWith('/100') ? '<b>The Last of Us</b>' : '',
            overview: 'Copy',
            genres: ''
        })
    });
    panel.account.chats[1].title = 'Одни из нас';
    await openSection(page, 'my-subs');
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_100"]')).toHaveText('<b>The Last of Us</b>');
    await expect(page.locator('#my-subs-body .row-name b')).toHaveCount(0);
    await page.locator('#my-subs-body [data-id="tv_100"]').click();
    await expect(page.locator('#mine-card-body h2')).toHaveText('<b>The Last of Us</b>');
    await expect(page.locator('#mine-card-body h2 b')).toHaveCount(0);
    await page.locator('#mine-card-modal [data-close="mine-card-modal"]').click();
    await expect(page.locator('#mine-card-modal')).toBeHidden();
    const filter = page.locator('[data-tab-find="subs"]');
    await filter.fill('Last of Us');
    await expect(filter).toHaveValue('Last of Us');
    await expect(page.locator('#my-subs-body .title-row')).toHaveCount(1);
    expect(panel.account.chats[1].title).toBe('Одни из нас');
});

test('admin tables and action sheets use the localized name without changing ids', async ({ page }) => {
    await mockPanel(page, {
        language: 'en',
        contentText: ({ path }) => ({
            title: path.endsWith('/66732') ? 'Localized catalog title' : '',
            overview: 'Copy',
            genres: ''
        })
    });
    await openSection(page, 'subs');
    await expect(page.locator('#subs-body [data-catalog-title="tv_66732"]').first()).toHaveText(
        'Localized catalog title'
    );
    await expect(page.locator('#subs-body [data-action="delete-sub"][data-series="66732"]').first()).toHaveAttribute(
        'aria-label',
        /Localized catalog title/
    );
    const title = page.locator('#subs-body [data-action="series"][data-id="66732"]:visible').first();
    await title.click();
    await expect(page.locator('#detail-body h2')).toHaveText('Localized catalog title');
    await page.locator('#detail-modal [data-close="detail-modal"]').click();
    await expect(page.locator('#detail-modal')).toBeHidden();
    await page.locator('#subs-filter').fill('Localized catalog');
    await expect(page.locator('#subs-body tr:visible').first()).toContainText('Localized catalog title');
});

test('a failed name lookup keeps the stored title', async ({ page }) => {
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: () => ({ status: 503, body: { error: 'Catalog unavailable' } })
    });
    await openSection(page, 'my-subs');
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_100"]')).toHaveText(panel.account.series[0].title);
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_100"]')).not.toHaveAttribute('aria-busy');
    await page.locator('#my-subs-body [data-id="tv_100"]').click();
    await expect(page.locator('#mine-card-body [data-localized="failed"]')).toBeVisible();
    await expect(page.locator('#mine-card-body h2')).toHaveText(panel.account.series[0].title);
    expect(page.__errors.filter((message) => !/503/.test(message))).toEqual([]);
    page.__errors = [];
});
