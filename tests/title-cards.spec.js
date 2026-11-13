const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, isPhone } = require('./helpers');

watchConsole();

test('native lazy loading loads visible posters and defers distant ones until scrolling', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('admin.pageSize.history-series', '100'));
    const requested = [];
    page.on('request', request => {
        if (request.url().includes('/api/poster/')) requested.push(new URL(request.url()).pathname);
    });
    await mockPanel(page, { history: () => ({
        years: [2026], year: 2026,
        series: Array.from({ length: 100 }, (_, i) => ({
            tmdbId: `tv_${i + 1}`, title: `Show ${i + 1}`, seasons: [1], genres: [],
            poster: `https://image.tmdb.org/t/p/w500/lazy${i}.png`,
            kinopoiskUrl: 'https://www.kinopoisk.ru/'
        })), films: []
    }) });
    await openSection(page, 'history');
    const images = page.locator('#history-series img.title-thumb');
    await expect(images).toHaveCount(100);
    await expect.poll(() => images.first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(requested).toContain('/api/poster/w185/lazy0.png');
    expect(requested).not.toContain('/api/poster/w185/lazy99.png');
    await images.last().scrollIntoViewIfNeeded();
    await expect.poll(() => images.last().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(requested).toContain('/api/poster/w185/lazy99.png');
});

test('account list posters are lazy while the opened card poster loads at once; it opens large', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', poster: true });
    panel.account.series[0].poster = '/poster.png';
    await openSection(page, 'my-subs');
    const poster = page.locator('#my-subs-body button.title-row img').first();
    await expect(poster).toHaveAttribute('loading', 'lazy');
    await poster.click();
    const cardPoster = page.locator('#mine-card-modal .tc-poster img');
    expect(await cardPoster.getAttribute('loading')).toBeNull();
    await expect(cardPoster).toHaveAttribute('src', '/api/poster/w185/poster.png');
    // The poster viewer: the large size over the card, the cross and a tap anywhere close it
    await page.locator('#mine-card-modal .tc-poster').click();
    const viewer = page.locator('#poster-modal');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.poster-view-img')).toHaveAttribute('alt', 'Poster: Одни из нас');
    await expect.poll(() => viewer.locator('.poster-view-img').getAttribute('src')).toBe('/api/poster/w500/poster.png');
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await page.locator('#mine-card-modal .tc-poster').click();
    await viewer.locator('.poster-view').click({ position: { x: 10, y: 10 } });
    await expect(viewer).toBeHidden();
    await expect(page.locator('#mine-card-modal')).toBeVisible();
});

test('Released reuses the poster and shows every listed season premiere, including the previous December', async ({ page }) => {
    await mockPanel(page, {
        poster: true,
        history: () => ({
            years: [2026], year: 2026,
            series: [{ tmdbId: 'tv_66732', title: 'Stranger Things', poster: 'https://image.tmdb.org/t/p/w500/poster.png', seasons: [4, 5, 6], seasonPremieres: [{season:4,date:'2025-12-15'},{season:5,date:'2026-03-20'},{season:6,date:'2026-06-01'}], genres: [], kinopoiskUrl: 'https://www.kinopoisk.ru/' }],
            films: []
        })
    });
    await openSection(page, 'history');
    const row = page.locator('#history-series .history-item').first();
    const image = row.locator('img');
    await expect(image).toHaveAttribute('loading', 'lazy');
    await row.locator('.history-open').press('Enter');
    const card = page.locator('#released-modal');
    await expect(card.locator('.tc-poster img')).toHaveAttribute('src', await image.getAttribute('src'));
    const date = card.locator('.tc-premieres');
    await expect(date).toContainText('Season 4');
    await expect(date.locator('.tc-season').nth(0)).toContainText('15 Dec2025');
    await expect(date.locator('.tc-season').nth(1)).toContainText('20 Mar2026');
    await expect(date.locator('.tc-season').nth(2)).toContainText('1 Jun2026');
    await expect(date).not.toContainText('2016');
});

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
        expect(await add.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
        const row = page.locator(`#${body} tr`).first();
        const poster = row.locator(isPhone(page) ? '.cell-compact .title-poster' : '.title-with-poster .title-poster');
        await expect(poster.locator('img')).toHaveAttribute('src', '/api/poster/w185/poster.png');
        await poster.click();
        await expect(page.locator('#detail-body .tc-scroll')).toContainText(date);
        await expect(page.locator('#detail-modal .tc-rating')).toContainText(section === 'subs' ? '8.4' : '7.1');
        const star = page.locator('#detail-modal .tc-rating svg');
        await expect(star.locator('use')).toHaveAttribute('href', '#i-star');
        await expect.poll(() => star.evaluate((el) => el.getBBox().width)).toBeGreaterThan(10);
        await expect(page.locator('#detail-modal .tc-facts')).not.toContainText('⭐');
        await page.locator('#detail-modal [data-close="detail-modal"]').click();
    }
});

test('Released is renamed everywhere and its rows open the title card', async ({ page }) => {
    await mockPanel(page, { poster: true });
    await openSection(page, 'history');
    await expect(page.locator('#history-section h1')).toHaveText('Released');
    await expect(page.locator('.nav-item[data-section="history"]')).toHaveAttribute('aria-label', 'Released');
    await expect(page.locator('#more-modal [data-section="history"]')).toContainText('Released');
    const row = page.locator('#history-series .history-open').first();
    await expect(row.locator('img')).toHaveAttribute('src', '/api/poster/w185/poster.png');
    await row.click();
    await expect(page.locator('#released-title')).toHaveText('Stranger Things');
});

test('long descriptions expand, collapse and reset when another card opens, with text escaped', async ({ page }) => {
    const overview = 'A long description with words. '.repeat(25) + '<img src=x onerror=alert(1)>';
    await mockPanel(page, { overview });
    await openSection(page, 'watchlist');
    const titles = page.locator(
        isPhone(page) ? '#watchlist-body .compact-title' : '#watchlist-body .title-with-poster .link-text'
    );
    await titles.first().click();
    const desc = page.locator('#detail-modal .tc-description');
    const toggle = desc.getByRole('button', { name: 'Show more' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(desc.locator('.tc-overview')).not.toHaveClass(/is-open/);
    await toggle.click();
    await expect(desc.locator('.tc-copy')).toHaveText(overview);
    await expect(desc.locator('img')).toHaveCount(0);
    await expect(desc.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    await desc.getByRole('button', { name: 'Show less' }).click();
    await expect(desc.locator('.tc-overview')).not.toHaveClass(/is-open/);
    await desc.getByRole('button', { name: 'Show more' }).click();
    await page.locator('#detail-modal [data-close="detail-modal"]').click();
    await titles.nth(1).click();
    await expect(desc.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false');
});

test('short descriptions stay visible without an expander', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'subs');
    await page
        .locator(isPhone(page) ? '#subs-body .compact-title' : '#subs-body .title-with-poster .link-text')
        .first()
        .click();
    await expect(page.locator('#detail-modal .tc-copy')).toHaveText('A test series.');
    await expect(page.locator('#detail-modal .tc-description').getByRole('button', { name: 'Show more' })).toBeHidden();
});
