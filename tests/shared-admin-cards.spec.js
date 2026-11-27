const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, isPhone } = require('./helpers');

watchConsole();

for (const language of ['en', 'ru']) {
    test(`unrated cards omit provider claims in ${language}`, async ({ page, isMobile }) => {
        if (process.env.RATING_FIX_CAPTURES) await page.setViewportSize({ width: isMobile ? 375 : 1440, height: isMobile ? 812 : 900 });
        await mockPanel(page, { language });
        let source = 'tvmaze';
        let rating = 0;
        await page.route('**/api/series/66732', route => route.fulfill({
            json: { name: 'Frisco King', number_of_seasons: 1, vote_average: rating,
                data_source: 'tvmaze', rating_source: source, subscribers: [] }
        }));
        const modal = page.locator('#detail-modal');
        const open = () => page.locator('#popular-list [data-action="series"]').first().click();
        for (source of ['tvmaze', 'tmdb', 'unknown']) {
            await open();
            await expect(modal.locator('.tc-rating')).toHaveText(language === 'ru' ? 'Пока нет оценки' : 'Not rated yet');
            expect(await modal.locator('.tc-rating').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
            if (process.env.RATING_FIX_CAPTURES && source === 'tmdb') {
                await modal.locator('.title-sheet').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
                await modal.locator('.tc-head').screenshot({ path: `${process.env.RATING_FIX_CAPTURES}/${language}-${isMobile ? 'iphone' : 'desktop'}.png` });
            }
            await modal.locator('[data-close="detail-modal"]').first().click();
            await expect(modal).toBeHidden();
        }
        source = 'tvmaze';
        rating = 5.3;
        await open();
        await expect(modal.locator('.tc-rating')).toContainText('5.3');
        await expect(modal.locator('.tc-rating')).toContainText('/ 10 · TVmaze');
    });
}

test('series details attribute TVmaze and its rating without changing the Kinopoisk link', async ({ page, isMobile }) => {
    if (process.env.SERIES_SOURCE_CAPTURES && !isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page);
    await page.route('**/api/series/66732', route => route.fulfill({
        json: {
            name: 'Stranger Things', number_of_seasons: 4, vote_average: 8.4,
            data_source: 'tvmaze', rating_source: 'tvmaze',
            source_url: 'https://www.tvmaze.com/shows/2993/stranger-things', subscribers: []
        }
    }));
    await page.locator('#popular-list [data-action="series"]').first().click();
    const modal = page.locator('#detail-modal');
    await expect(modal.locator('.tc-source')).toHaveText('Source: TVmaze');
    await expect(modal.locator('.tc-source')).toHaveAttribute('href', 'https://www.tvmaze.com/shows/2993/stranger-things');
    await expect(modal.locator('.tc-rating')).toContainText('/ 10 · TVmaze');
    await expect(modal.locator('.tc-link:not(.tc-source)')).toHaveAttribute('href', 'https://www.kinopoisk.ru/series/435/');
    if (process.env.SERIES_SOURCE_CAPTURES) {
        const sheet = modal.locator('.title-sheet');
        await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        await sheet.screenshot({ path: `${process.env.SERIES_SOURCE_CAPTURES}/${isMobile ? 'iphone' : 'desktop'}.png` });
    }
});

test('Following preserves the series source and rating attribution', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.series[0].source = { label: 'TVmaze', url: 'https://www.tvmaze.com/shows/618/the-last-of-us' };
    panel.account.series[0].ratingSource = 'TVmaze';
    panel.account.series[0].rating = 5.3;
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body button.title-row').first().click();
    const modal = page.locator('#mine-card-modal');
    await expect(modal.locator('.tc-source')).toHaveText('Source: TVmaze');
    await expect(modal.locator('.tc-rating')).toContainText('TVmaze');
    await expect(modal.locator('.tc-rating')).toContainText('5.3');
});

test('restored ratings show their reserve or unknown source accurately', async ({ page, isMobile }) => {
    if (process.env.AUDIT_RATING_CAPTURES && !isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page);
    let source = 'tmdb';
    await page.route('**/api/series/66732', route => route.fulfill({
        json: { name: 'Stranger Things', vote_average: 8.5, data_source: 'tvmaze', rating_source: source, subscribers: [] }
    }));
    const open = () => page.locator('#popular-list [data-action="series"]').first().click();
    const modal = page.locator('#detail-modal');
    await open();
    await expect(modal.locator('.tc-rating')).toContainText('/ 10 · TMDB');
    await page.keyboard.press('Escape');
    source = 'unknown';
    await open();
    await expect(modal.locator('.tc-rating')).toContainText('/ 10 · Catalog');
    await expect(modal.locator('.tc-rating')).not.toContainText('TVmaze');
    if (process.env.AUDIT_RATING_CAPTURES) {
        const sheet = modal.locator('.title-sheet');
        await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        await sheet.screenshot({ path: `${process.env.AUDIT_RATING_CAPTURES}/${isMobile ? 'iphone' : 'desktop'}.png` });
    }
});

test('admin details use the shared title sheet and poster viewer', async ({ page, isMobile }) => {
    if (process.env.ADMIN_CARD_CAPTURES && !isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page, { poster: true });
    await page.locator('#popular-list [data-action="series"]').first().click();
    const modal = page.locator('#detail-modal');
    await expect(modal.locator('.title-sheet .tc-head h2')).toHaveText('Stranger Things');
    await expect(modal.locator('.tc-scroll')).toHaveCount(1);
    await expect(modal.locator('.sheet-grabber')).toHaveCount(1);
    await expect(modal.locator('.people-group h3')).toHaveText('Subscribers · 3');
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

test('title sheet keeps equal side gaps clear of the scrollbar', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page, { poster: true });
    await page.locator('#popular-list [data-action="series"]').first().click();
    const sheet = page.locator('#detail-modal .title-sheet');
    await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    await page.locator('#detail-modal .tc-link').waitFor();
    const layout = await sheet.evaluate(el => {
        const box = el.getBoundingClientRect();
        const scroll = el.querySelector('.tc-scroll');
        const scrollBox = scroll.getBoundingClientRect();
        // Where a classic scrollbar starts; overlay scrollbars take no width here.
        const barStart = scrollBox.left + scroll.clientLeft + scroll.clientWidth;
        return ['.tc-head', '.tc-date', '.tc-link'].map(sel => {
            const part = el.querySelector(sel).getBoundingClientRect();
            const gap = Math.round(part.left - box.left) - Math.round(box.right - part.right);
            return { gap, clear: part.right <= barStart && box.right - part.right >= 16 };
        });
    });
    expect(layout).toEqual(Array(3).fill({ gap: 0, clear: true }));
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
        return ['/path.jpg', 'https://image.tmdb.org/t/p/w500/path.webp', '', null,
            'https://static.tvmaze.com/uploads/images/original_untouched/500/123.jpg'].map(path => {
            const root = document.createElement('div');
            root.innerHTML = titleThumb(path);
            return { src: root.querySelector('img')?.getAttribute('src') || '', expected: posterSrc(path), empty: Boolean(root.querySelector('.title-thumb-empty')) };
        });
    });
    expect(formats.map(f => f.src)).toEqual(['/api/poster/w185/path.jpg', '/api/poster/w185/path.webp', '', '', '/api/poster/w185/tvmaze/500/123.jpg']);
    expect(formats.map(f => f.empty)).toEqual([false, false, true, true, false]);
});
