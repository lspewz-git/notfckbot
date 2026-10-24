const { test, expect } = require('@playwright/test');
const { watchConsole } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Series and film cards, on the canned API: who is subscribed or waiting, and the
 * Kinopoisk button, which goes straight to the title once the server knows its ID.
 */

watchConsole();

const card = (page) => page.locator('#detail-modal');

/** Opens Stranger Things from Popular now: three chats follow it, two of them every episode. */
async function openSeriesCard(page) {
    await page.locator('#popular-list [data-action="series"]').first().click();
    await expect(card(page).locator('#detail-title')).toHaveText('Stranger Things');
}

test("a series card lists who is subscribed, with each chat's mode", async ({ page }) => {
    await mockPanel(page);
    await openSeriesCard(page);

    const group = card(page).locator('.people-group');
    await expect(group.locator('h4')).toHaveText('Subscribers · 3');
    const rows = group.locator('li');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'alice' })).toContainText('Every episode');
    await expect(rows.filter({ hasText: 'bob' })).toContainText('Whole season');
    await expect(rows.filter({ hasText: 'Movie Club' })).toContainText('Every episode');
    await expect(card(page).locator('#detail-meta')).toContainText('TMDB ⭐️ 8.4');
    // Release dates are a film's: no block for a series
    await expect(card(page).locator('#detail-dates')).toBeHidden();
});

test("the Kinopoisk button opens the title's page in a new tab", async ({ page }) => {
    await mockPanel(page);
    await openSeriesCard(page);

    const button = card(page).getByRole('link', { name: 'Open on Kinopoisk' });
    await expect(button).toHaveAttribute('href', 'https://www.kinopoisk.ru/series/435/');
    await expect(button).toHaveAttribute('target', '_blank');
});

test('a title Kinopoisk is not known for gets a search link', async ({ page }) => {
    const url = 'https://www.kinopoisk.ru/index.php?kp_query=Stranger%20Things';
    await mockPanel(page, { kinopoisk: { id: null, url } });
    await openSeriesCard(page);
    const button = card(page).getByRole('link', { name: 'Open on Kinopoisk' });
    await expect(button).toHaveAttribute('href', url);
    await expect(button).toHaveAttribute('title', 'Kinopoisk search by title');
});

test('a film card splits chats into waiting and already notified', async ({ page }) => {
    // Dune (movie_6) was released and announced; Dune: Part Three (movie_1) is still awaited
    const day = new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10);
    const upcoming = [
        { kind: 'movie', id: 'movie_6', title: 'Dune', date: day, chats: 1 },
        { kind: 'movie', id: 'movie_1', title: 'Dune: Part Three', date: day, chats: 1 }
    ];
    await mockPanel(page, { upcoming });

    await page.locator('#upcoming-list [data-id="movie_6"]').click();
    await expect(card(page).locator('#detail-title')).toHaveText('Dune');
    await expect(card(page).locator('.people-group h4')).toHaveText(['Already notified · 1']);
    await expect(card(page).locator('.people-group li')).toContainText('alice');
    await expect(card(page).locator('#detail-kp')).toHaveAttribute('href', /\/film\/435\/$/);

    await page.keyboard.press('Escape');
    await page.locator('#upcoming-list [data-id="movie_1"]').click();
    await expect(card(page).locator('#detail-title')).toHaveText('Dune: Part Three');
    await expect(card(page).locator('.people-group h4')).toHaveText(['Waiting for release · 1']);
});

test("the Kinopoisk button keeps its size when the title's page replaces the search", async ({ page }) => {
    let release;
    const kinopoiskHold = new Promise((r) => (release = r));
    await mockPanel(page, { kinopoiskHold });
    await openSeriesCard(page);

    const button = card(page).locator('#detail-kp');
    await expect(button).toHaveAttribute('href', /kp_query=Stranger%20Things/);
    // The dialog scales in as it opens; measure once it has settled
    const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await settled();
    const before = await button.boundingBox();

    release();
    await expect(button).toHaveAttribute('href', 'https://www.kinopoisk.ru/series/435/');
    await settled();
    const after = await button.boundingBox();
    expect(after).toEqual(before);
    await expect(button).toHaveText('Open on Kinopoisk');
});

test("a film card lists the film's dates, TBA when none is known", async ({ page }) => {
    const day = new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10);
    const upcoming = [
        { kind: 'movie', id: 'movie_5', title: 'Hunger Games', date: day, chats: 1 },
        { kind: 'movie', id: 'movie_3', title: 'No Date Yet', date: day, chats: 1 },
        { kind: 'movie', id: 'movie_4', title: 'Spider-Man 4', date: day, chats: 1 }
    ];
    await mockPanel(page, { upcoming });

    await page.locator('#upcoming-list [data-id="movie_5"]').click();
    const dates = card(page).locator('#detail-dates');
    await expect(dates.locator('dt')).toHaveText(['Release', 'Premiere in Russia', 'Digital in Russia']);
    await expect(dates).toContainText('15 Jan 2027 · Okko');
    // The release date moved from the line under the title to the list
    await expect(card(page).locator('#detail-meta')).not.toContainText('Nov');

    await page.keyboard.press('Escape');
    await page.locator('#upcoming-list [data-id="movie_4"]').click();
    await expect(dates.locator('dd').nth(1)).toHaveText('Feb 2027');

    await page.keyboard.press('Escape');
    await page.locator('#upcoming-list [data-id="movie_3"]').click();
    await expect(card(page).locator('#detail-title')).toHaveText('No Date Yet');
    await expect(dates.locator('dd')).toHaveText(['TBA']);
});

test('on a phone a small poster sits beside the title, the description under both at full width', async ({ page }) => {
    test.skip(page.viewportSize().width > 560, 'the phone layout');
    await mockPanel(page, { poster: true });
    await openSeriesCard(page);
    const poster = card(page).locator('#detail-poster');
    await expect(poster).toBeVisible();
    const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await settled();
    const [p, title, meta, desc] = await Promise.all(
        [
            poster,
            card(page).locator('#detail-title'),
            card(page).locator('#detail-meta'),
            card(page).locator('#detail-desc')
        ].map((l) => l.boundingBox())
    );
    expect(p.width).toBeLessThanOrEqual(60);
    expect(title.x).toBeGreaterThan(p.x + p.width);
    expect(meta.x).toBe(title.x);
    expect(desc.y).toBeGreaterThanOrEqual(p.y + p.height - 1);
    expect(Math.abs(desc.x - p.x)).toBeLessThan(1);
});
