const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, isPhone } = require('./helpers');

watchConsole();

for (const language of ['en', 'ru']) {
    for (const built of [false, true]) {
        test(`TVmaze artwork survives opening the admin card and viewer (${language}, built=${built})`, async ({
            page
        }) => {
            const panel = await mockPanel(page, { language, built, poster: true });
            for (const sub of panel.subs)
                sub.Series = {
                    ...sub.Series,
                    poster_url: 'https://static.tvmaze.com/uploads/images/original_untouched/500/123.jpg'
                };
            await openSection(page, 'subs');
            const row = page.locator('#subs-body tr').first();
            const poster = row.locator(
                isPhone(page) ? '.cell-compact .title-poster' : '.title-with-poster .title-poster'
            );
            await expect(poster.locator('img')).toHaveAttribute('src', '/api/poster/w185/tvmaze/500/123.jpg');
            await poster.click();
            const card = page.locator('#detail-modal');
            await expect(card.locator('.tc-poster img').first()).toHaveAttribute(
                'src',
                '/api/poster/w185/tvmaze/500/123.jpg'
            );
            await expect
                .poll(() =>
                    card
                        .locator('.tc-poster img')
                        .first()
                        .evaluate((img) => img.naturalWidth)
                )
                .toBeGreaterThan(0);
            await card.locator('.tc-poster').click();
            const viewer = page.locator('#poster-modal');
            await expect(viewer).toBeVisible();
            await expect(viewer.locator('.poster-view-img')).toHaveAttribute(
                'src',
                '/api/poster/w500/tvmaze/500/123.jpg'
            );
            await expect
                .poll(() => viewer.locator('.poster-view-img').evaluate((img) => img.naturalWidth))
                .toBeGreaterThan(0);
            await expect(viewer.locator('.poster-view')).not.toHaveAttribute('aria-busy', 'true');
            await expect(viewer.locator('.poster-retry')).toBeHidden();
        });
    }

    test(`admin list categories have room below search (${language})`, async ({ page }) => {
        await mockPanel(page, { language });
        for (const section of ['chats', 'subs', 'watchlist']) {
            await openSection(page, section);
            const root = page.locator(`#${section}-section .list-page`);
            const search = await root.locator(':scope > .search-pill').boundingBox();
            const chip = await root.locator(':scope > .cat-bar .tab-filters .btn').first().boundingBox();
            expect(chip.y - (search.y + search.height), section).toBeGreaterThanOrEqual(12);
        }
    });
}

test('cached poster addresses preserve provider and requested size', async ({ page }) => {
    await mockPanel(page);
    const sources = await page.evaluate(async () => {
        const { posterSrc } = await import('/js/title-card.js');
        return [
            'https://static.tvmaze.com/uploads/images/medium_portrait/500/123.jpg',
            '/api/poster/w185/tvmaze/500/123.jpg',
            '/api/poster/w500/tvmaze/500/123.jpg',
            '/api/poster/w185/cover.jpg',
            '/cover.jpg'
        ].map((src) => [posterSrc(src), posterSrc(src, 'w500')]);
    });
    expect(sources).toEqual([
        ['/api/poster/w185/tvmaze/500/123.jpg', '/api/poster/w500/tvmaze/500/123.jpg'],
        ['/api/poster/w185/tvmaze/500/123.jpg', '/api/poster/w500/tvmaze/500/123.jpg'],
        ['/api/poster/w185/tvmaze/500/123.jpg', '/api/poster/w500/tvmaze/500/123.jpg'],
        ['/api/poster/w185/cover.jpg', '/api/poster/w500/cover.jpg'],
        ['/api/poster/w185/cover.jpg', '/api/poster/w500/cover.jpg']
    ]);
});
