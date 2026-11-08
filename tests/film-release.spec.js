const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection } = require('./helpers');

watchConsole();

test('Ёлки 13 keeps Dec 10 Release in Following and Calendar, with an explicit unknown digital date', async ({
    page
}, info) => {
    const panel = await mockPanel(page, { role: 'user' });
    const release = { date: '2026-12-10', country: 'RU', countries: ['RU'] };
    const film = {
        id: 44,
        tmdbId: 'movie_1644597',
        title: 'Ёлки 13',
        year: 2026,
        date: release.date,
        release,
        cinemaRu: release.date,
        online: null,
        notifyDigital: false,
        poster: null,
        genres: 'комедия',
        overview: '',
        links: []
    };
    panel.account.films = [film];
    panel.account.calendar.items = [
        {
            ...film,
            kind: 'movie',
            listId: film.id,
            event: 'release',
            country: 'RU',
            countries: ['RU'],
            notifyOn: release.date
        }
    ];
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body [role="tab"]', { hasText: 'Films' }).click();
    await page.locator('#my-subs-body button.title-row', { hasText: film.title }).click();
    const card = page.locator('#mine-card-modal');
    const expected = ['Dec 10, 2026 · Russia', 'Date unknown'];
    await expect(card.locator('.tc-date-value')).toHaveText(expected);
    await expect(card.locator('.tc-date-label').filter({ hasText: /^(Release|Digital release)$/ })).toHaveText([
        'Release',
        'Digital release'
    ]);
    await expect(card.locator('.tc-bell')).toHaveCount(1);
    const followingDates = await card.locator('.tc-date').allTextContents();
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await openSection(page, 'my-calendar');
    await page.locator('#my-calendar-body [role="tab"]', { hasText: 'Films' }).click();
    const row = page.locator('#my-calendar-body .cal-row', { hasText: film.title });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-meta')).toHaveText('Release · Russia');
    await expect(row.locator('.cal-day b')).toHaveText('10');
    await row.click();
    await expect(card.locator('.tc-date-value')).toHaveText(expected);
    expect(await card.locator('.tc-date').allTextContents()).toEqual(followingDates);
    await expect(card).not.toContainText(/45 days|estimate|Jan 24/);
    if (process.env.CAPTURE_FILM_UI) {
        await card
            .locator('.title-sheet')
            .screenshot({ path: path.resolve(`previews/film-release-card-${info.project.name}.png`) });
    }
});

test('Released keeps a distinct Russian digital date and attaches its service to Russia', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.airedFilmDates = {
        release: '2026-02-01',
        releaseCountries: ['US'],
        digital: '2026-03-01',
        digitalCountry: 'US',
        ruDigital: '2026-03-20',
        ruServices: 'Okko'
    };
    await openSection(page, 'my-aired');
    await page.locator('#my-aired-films .history-open').click();
    const digital = page.locator('#released-modal .tc-date').nth(1);
    await expect(digital.locator('.tc-date-value')).toHaveText('1 Mar 2026 · United States');
    await expect(digital).toContainText('In Russia 20 Mar 2026 · Okko');
});

test('a digital-only main Release uses the same two existing date blocks', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.calendar.items = [
        {
            kind: 'movie',
            tmdbId: 'movie_55',
            listId: 55,
            title: 'Digital-only film',
            date: '2026-12-23',
            event: 'release',
            country: 'US',
            release: { date: '2026-12-23', country: 'US', countries: ['US'] },
            online: { date: '2026-12-23', country: 'US' },
            notifyDigital: false,
            notifyOn: '2026-12-23'
        }
    ];
    await openSection(page, 'my-calendar');
    await page.locator('#my-calendar-body [role="tab"]', { hasText: 'Films' }).click();
    await page.locator('#my-calendar-body .cal-row').click();
    const card = page.locator('#mine-card-modal');
    await expect(card.locator('.tc-date')).toHaveCount(2);
    await expect(card.locator('.tc-date-value')).toHaveText([
        'Dec 23, 2026 · United States',
        'Dec 23, 2026 · United States'
    ]);
    await expect(card.locator('.tc-bell')).toHaveCount(1);
});
