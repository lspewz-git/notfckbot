const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, isPhone } = require('./helpers');

watchConsole();

test('Serials and Movies show clickable posters, round add controls and release dates', async ({ page }) => {
    await mockPanel(page, { poster: true });
    for (const [section, body, label, date] of [
        ['subs', 'subs-body', 'Add serial', '15 Jul 2016'],
        ['watchlist', 'watchlist-body', 'Add movie', '18 Dec 2026']
    ]) {
        await openSection(page, section);
        const add = page.locator(`#${section}-section`).getByRole('button', { name: label, exact: true });
        await expect(add).toHaveText('');
        const box = await add.boundingBox();
        expect(box.width).toBe(box.height);
        expect(await add.evaluate(el => getComputedStyle(el).borderRadius)).toBe('50%');
        const row = page.locator(`#${body} tr`).first();
        const poster = row.locator(isPhone(page) ? '.cell-compact .title-poster' : '.title-with-poster .title-poster');
        await expect(poster.locator('img')).toHaveAttribute('src', '/api/poster/w185/poster.png');
        await poster.click();
        await expect(page.locator('#detail-dates')).toContainText(date);
        await page.locator('#detail-modal [data-close="detail-modal"]').click();
    }
});

test('Aired is renamed everywhere and its posters open the title card', async ({ page }) => {
    await mockPanel(page, { poster: true });
    await openSection(page, 'history');
    await expect(page.locator('#history-section h1')).toHaveText('Aired');
    await expect(page.locator('.nav-item[data-section="history"]')).toHaveAttribute('aria-label', 'Aired');
    await expect(page.locator('#more-modal [data-section="history"]')).toContainText('Aired');
    const poster = page.locator('#history-series .title-poster').first();
    await expect(poster.locator('img')).toHaveAttribute('src', '/api/poster/w185/poster.png');
    await poster.click();
    await expect(page.locator('#detail-title')).toHaveText('Stranger Things');
});

test('long descriptions expand, collapse and reset when another card opens, with text escaped', async ({ page }) => {
    const overview = 'A long description with words. '.repeat(25) + '<img src=x onerror=alert(1)>';
    await mockPanel(page, { overview });
    await openSection(page, 'watchlist');
    const titles = page.locator(isPhone(page) ? '#watchlist-body .compact-title' : '#watchlist-body .title-with-poster .link-text');
    await titles.first().click();
    const desc = page.locator('#detail-desc');
    const toggle = desc.getByRole('button', { name: 'Show more' });
    expect(Array.from(await desc.locator('[data-description-short]').innerText()).length).toBeLessThanOrEqual(300);
    await toggle.click();
    await expect(desc.locator('[data-description-full]')).toHaveText(overview);
    await expect(desc.locator('img')).toHaveCount(0);
    await expect(desc.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    await desc.getByRole('button', { name: 'Show less' }).click();
    await expect(desc.locator('[data-description-full]')).toBeHidden();
    await desc.getByRole('button', { name: 'Show more' }).click();
    await page.locator('#detail-modal [data-close="detail-modal"]').click();
    await titles.nth(1).click();
    await expect(desc.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false');
});

test('short descriptions stay visible without an expander', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'subs');
    await page.locator(isPhone(page) ? '#subs-body .compact-title' : '#subs-body .title-with-poster .link-text').first().click();
    await expect(page.locator('#detail-desc')).toHaveText('A test series.');
    await expect(page.locator('#detail-desc button')).toHaveCount(0);
});
