const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, isPhone } = require('./helpers');

watchConsole();

test('admin details use the shared title sheet and poster viewer', async ({ page, isMobile }) => {
    if (process.env.ADMIN_CARD_CAPTURES && !isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page, { poster: true });
    await page.locator('#popular-list [data-action="series"]').first().click();
    const modal = page.locator('#detail-modal');
    await expect(modal.locator('.title-sheet .tc-head h2')).toHaveText('Stranger Things');
    await expect(modal.locator('.tc-scroll')).toHaveCount(1);
    await expect(modal.locator('.sheet-grabber')).toHaveCount(1);
    await expect(modal.locator('.people-group h4')).toHaveText('Subscribers · 3');
    if (process.env.ADMIN_CARD_CAPTURES) {
        await modal.locator('.title-sheet').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        await modal.locator('.tc-link').waitFor();
        await modal.locator('.title-sheet').screenshot({ path: `${process.env.ADMIN_CARD_CAPTURES}/${isMobile ? 'mobile' : 'desktop'}.png` });
    }
    await modal.locator('.tc-poster').click();
    await expect(page.locator('#poster-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#poster-modal')).toBeHidden();
    await expect(modal).toBeVisible();
});

test('late details and Kinopoisk answers cannot replace the newly opened title', async ({ page }) => {
    let releaseDetails, releaseLink;
    const options = {
        apiHold: {
            '/api/series/66732': new Promise(resolve => { releaseDetails = resolve; }),
            '/api/kinopoisk/tv/66732': new Promise(resolve => { releaseLink = resolve; })
        }
    };
    await mockPanel(page, options);
    await page.evaluate(() => import('/js/records.js').then(m => { m.openSeriesDetails('66732'); }));
    await expect(page.locator('#detail-title')).toHaveText('Loading details…');
    await page.evaluate(() => import('/js/records.js').then(m => { m.openFilmDetails('movie_1'); }));
    await expect(page.locator('#detail-title')).toHaveText('Dune: Part Three');
    const oldResponse = page.waitForResponse(r => r.url().endsWith('/api/series/66732'));
    releaseDetails();
    await oldResponse;
    await expect(page.locator('#detail-title')).toHaveText('Dune: Part Three');
    // Now let the series open, with only its independent link lookup held.
    await page.evaluate(() => import('/js/records.js').then(m => { m.openSeriesDetails('66732'); }));
    await expect(page.locator('#detail-title')).toHaveText('Stranger Things');
    await page.evaluate(() => import('/js/records.js').then(m => { m.openFilmDetails('movie_1'); }));
    const link = page.locator('#detail-modal .tc-link');
    await expect(link).toHaveAttribute('href', 'https://www.kinopoisk.ru/film/435/');
    const oldLink = page.waitForResponse(r => r.url().endsWith('/api/kinopoisk/tv/66732'));
    releaseLink();
    await oldLink;
    await expect(link).toHaveAttribute('href', 'https://www.kinopoisk.ru/film/435/');
    await expect(page.locator('#detail-title')).toHaveText('Dune: Part Three');
});

test('a closed loading sheet stays closed when details arrive', async ({ page }) => {
    let release;
    await mockPanel(page, { apiHold: { '/api/series/66732': new Promise(resolve => { release = resolve; }) } });
    await page.evaluate(() => import('/js/records.js').then(m => { m.openSeriesDetails('66732'); }));
    await page.keyboard.press('Escape');
    await expect(page.locator('#detail-modal')).toBeHidden();
    const response = page.waitForResponse(r => r.url().endsWith('/api/series/66732'));
    release();
    await response;
    await expect(page.locator('#detail-modal')).toBeHidden();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('table posters use the same JPEG URL normalization as shared thumbnails', async ({ page }) => {
    const panel = await mockPanel(page, { poster: true });
    for (const sub of panel.subs) sub.Series = { ...sub.Series, poster_url: 'https://image.tmdb.org/t/p/w500/cover.JPEG' };
    await openSection(page, 'subs');
    const row = page.locator('#subs-body tr').first();
    const poster = row.locator(isPhone(page) ? '.cell-compact .title-poster img' : '.title-with-poster .title-poster img');
    await expect(poster).toHaveAttribute('src', '/api/poster/w185/cover.JPEG');
    const formats = await page.evaluate(async () => {
        const { posterSrc, titleThumb } = await import('/js/title-card.js');
        return ['/path.jpg', 'https://image.tmdb.org/t/p/w500/path.webp', '', null].map(path => {
            const root = document.createElement('div');
            root.innerHTML = titleThumb(path);
            return { src: root.querySelector('img')?.getAttribute('src') || '', expected: posterSrc(path), empty: Boolean(root.querySelector('.title-thumb-empty')) };
        });
    });
    expect(formats.map(f => f.src)).toEqual(['/api/poster/w185/path.jpg', '/api/poster/w185/path.webp', '', '']);
    expect(formats.map(f => f.empty)).toEqual([false, false, true, true]);
});
