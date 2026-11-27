const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, openProfilePage, openActions } = require('./helpers');

watchConsole();

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

test('an already open Mode dialog follows a late localized name', async ({ page, isMobile }) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await mockPanel(page, {
        language: 'en',
        contentText: async ({ path }) => {
            if (!path.endsWith('/66732')) return { title: '', overview: '', genres: '' };
            await gate;
            return { title: 'Late localized title', overview: 'Copy', genres: '' };
        }
    });
    await openSection(page, 'subs');
    const row = page
        .locator('#subs-body tr')
        .filter({ has: page.locator('[data-action="series"][data-id="66732"]') })
        .first();
    if (isMobile) {
        await row.locator('[data-action="sub-actions"]').click();
        await page.locator('#sub-action-mode').click();
    } else await row.locator('[data-action="mode"]').click();
    await expect(page.locator('#mode-modal')).toBeVisible();
    release();
    await expect(page.locator('#mode-target')).toContainText('Late localized title');
});

test('an already open Unfollow confirmation follows a late localized name', async ({ page }) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: async ({ path }) => {
            if (!path.endsWith('/100')) return { title: '', overview: '', genres: '' };
            await gate;
            return { title: 'Late localized title', overview: 'Copy', genres: '' };
        }
    });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body [data-id="tv_100"]').click();
    await page.locator('#mine-card-body [data-action="mine-ask-unfollow"]').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    release();
    await expect(page.locator('#confirm-title')).toContainText('Late localized title');
});

test('visible name lookups are bounded and share requests with an opened card', async ({ page }) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let active = 0;
    let peak = 0;
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: async ({ path }) => {
            peak = Math.max(peak, ++active);
            await gate;
            active--;
            return { title: `Localized ${path.split('/').pop()}`, overview: 'Copy', genres: '' };
        }
    });
    panel.account.series = Array.from({ length: 12 }, (_, i) => ({
        ...panel.account.series[0],
        id: `tv_${100 + i}`,
        title: `Stored ${i}`
    }));
    await openSection(page, 'my-subs');
    await expect.poll(() => active).toBe(4);
    await page.locator('#my-subs-body [data-id="tv_100"]').click();
    release();
    await expect(page.locator('#mine-card-body h2')).toHaveText('Localized 100');
    expect(peak).toBe(4);
    expect(panel.account.sent.filter((r) => r.path === '/api/account/content/tv/100')).toHaveLength(1);
});

test('a late name updates the tracked-title picker without resetting the selected id or edited episode', async ({
    page
}) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const panel = await mockPanel(page, {
        language: 'en',
        contentText: async () => {
            await gate;
            return { title: 'Late catalog title', overview: '', genres: '' };
        }
    });
    await openSection(page, 'dashboard');
    await openActions(page);
    await page.locator('#test-notify-btn').click();
    await expect(page.locator('#test-notify-modal')).toBeVisible();
    const select = page.locator('#test-notify-series-select');
    const selected = await select.inputValue();
    await page.locator('#test-notify-season').fill('9');
    await page.locator('#test-notify-episode').fill('17');
    const trigger = page.locator('.custom-select:has(#test-notify-series-select) .custom-select-trigger');
    await trigger.click();
    release();
    await expect(trigger).toContainText('Late catalog title');
    await expect(page.locator('.custom-select-option').first()).toContainText('Late catalog title');
    await expect(select).toHaveValue(selected);
    await expect(page.locator('#test-notify-season')).toHaveValue('9');
    await expect(page.locator('#test-notify-episode')).toHaveValue('17');
    expect(panel.lastTest).toBeUndefined();
});

test('a hidden page stops its queued name lookups and resumes after a cached-page restore', async ({ page }) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let requests = 0;
    let active = 0;
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: async ({ path }) => {
            requests++;
            active++;
            await gate;
            active--;
            return { title: `Localized ${path.split('/').pop()}`, overview: '', genres: '' };
        }
    });
    panel.account.series = Array.from({ length: 12 }, (_, i) => ({
        ...panel.account.series[0],
        id: `tv_${100 + i}`,
        title: `Stored ${i}`
    }));
    await openSection(page, 'my-subs');
    await expect.poll(() => active).toBe(4);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    release();
    await expect.poll(() => active).toBe(0);
    await page.waitForTimeout(150);
    expect(requests).toBe(4);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => requests).toBeGreaterThan(4);
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_104"]')).toHaveText('Localized 104');
});

test('a cancelled navigation resumes queued names on the next interaction', async ({ page }) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let requests = 0;
    let active = 0;
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: async ({ path }) => {
            requests++;
            active++;
            await gate;
            active--;
            return { title: `Localized ${path.split('/').pop()}`, overview: '', genres: '' };
        }
    });
    panel.account.series = Array.from({ length: 12 }, (_, i) => ({
        ...panel.account.series[0],
        id: `tv_${100 + i}`,
        title: `Stored ${i}`
    }));
    await openSection(page, 'my-subs');
    await expect.poll(() => active).toBe(4);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    release();
    await expect.poll(() => active).toBe(0);
    await page.waitForTimeout(150);
    expect(requests).toBe(4);
    await page.keyboard.press('Shift');
    await expect.poll(() => requests).toBeGreaterThan(4);
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_104"]')).toHaveText('Localized 104');
});

test('a failed name lookup keeps the stored title', async ({ page }) => {
    const panel = await mockPanel(page, {
        role: 'user',
        language: 'en',
        contentText: () => ({ status: 503, body: { error: 'Catalog unavailable' } })
    });
    await openSection(page, 'my-subs');
    await expect(page.locator('#my-subs-body [data-catalog-title="tv_100"]')).toHaveText(panel.account.series[0].title);
    await page.locator('#my-subs-body [data-id="tv_100"]').click();
    await expect(page.locator('#mine-card-body [data-localized="failed"]')).toBeVisible();
    await expect(page.locator('#mine-card-body h2')).toHaveText(panel.account.series[0].title);
    expect(page.__errors.filter((message) => !/503/.test(message))).toEqual([]);
    page.__errors = [];
});
