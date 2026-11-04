const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, pickChat } = require('./helpers');

test.describe('shared cards and calendar unfollow', () => {
    watchConsole();

    test('a pending mode save blocks unfollow even after reopening the calendar card', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        let release;
        panel.account.modeHold = new Promise((resolve) => {
            release = resolve;
        });
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body .mine-row').first().click();
        const card = page.locator('#mine-card-modal');
        try {
            await card.getByLabel('When the whole season is out').check();
            await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toBeDisabled();
            await card.getByRole('button', { name: 'Close', exact: true }).click();
            await openSection(page, 'my-calendar');
            const episode = page.locator('#my-calendar-body .mine-cal-row').first();
            await episode.click();
            await expect(card.locator('.mine-modes')).toHaveCount(0);
            await card.getByRole('button', { name: 'Close', exact: true }).click();
            await episode.click();
            await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toBeDisabled();
            expect(panel.account.sent.filter((r) => r.method === 'DELETE')).toHaveLength(0);
        } finally {
            release();
        }
        await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toBeEnabled();
        await expect(card.locator('.mine-modes')).toHaveCount(0);
        await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
        await card.getByRole('button', { name: 'Yes, unfollow', exact: true }).click();
        await expect(card).toBeHidden();
        expect(panel.account.series.some((item) => item.id === 'tv_100')).toBe(false);
    });

    test('notification mode can be changed in Following and is absent from Calendar', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        await openSection(page, 'my-calendar');
        await page.locator('#my-calendar-body .mine-cal-row').first().click();
        const card = page.locator('#mine-card-modal');
        await expect(card.locator('.mine-modes')).toHaveCount(0);
        expect(panel.account.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/series'))).toHaveLength(0);
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body .mine-row').first().click();
        await card.getByLabel('When the whole season is out').check();
        await expect(page.locator('.toast').last()).toContainText('Notifications changed');
        expect(panel.account.sent.find((r) => r.method === 'POST' && r.path.endsWith('/series')).body).toEqual({
            tmdbId: 'tv_100',
            mode: 'season'
        });
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await openSection(page, 'my-calendar');
        await page.locator('#my-calendar-body .mine-cal-row').first().click();
        await expect(card.locator('.mine-modes')).toHaveCount(0);
    });

    test('Following and Calendar use the same film card, compact date and spaced actions', async ({ page }) => {
        await mockPanel(page, { role: 'user' });
        await openSection(page, 'my-subs');
        await expect(page.locator('#my-subs-section h1')).toHaveText('Following');
        await page.locator('[data-action="mine-subs-tab"][data-tab="films"]').click();
        await page.locator('#my-subs-body .mine-row').click();
        const card = page.locator('#mine-card-modal');
        const following = await card.locator('.mine-following-card').innerHTML();
        const gap = await card.evaluate((el) => {
            const note = el.querySelector('.mine-card-note').getBoundingClientRect();
            const button = el.querySelector('.mine-links').getBoundingClientRect();
            return button.top - note.bottom;
        });
        expect(gap).toBeGreaterThanOrEqual(20);
        const date = card.locator('.mine-card-head .mine-release-date');
        await expect(date).toContainText('In 2 days');
        expect(await date.evaluate((el) => getComputedStyle(el).borderStyle)).toBe('none');
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await openSection(page, 'my-calendar');
        await page.locator('[data-action="mine-cal-what"][data-what="films"]').click();
        await page.locator('#my-calendar-body .mine-cal-row', { hasText: 'Дюна' }).click();
        await expect(card.locator('.mine-following-card')).toHaveJSProperty('innerHTML', following);
    });

    for (const kind of ['series', 'films']) {
        test(`calendar unfollow removes the whole ${kind} subscription in the chosen chat after confirmation`, async ({
            page
        }) => {
            const panel = await mockPanel(page, { role: 'user' });
            await openSection(page, 'my-calendar');
            await pickChat(page, 'my-calendar', 'Киноклуб');
            const body = page.locator('#my-calendar-body');
            if (kind === 'films') await body.locator('[data-action="mine-cal-what"][data-what="films"]').click();
            await body.locator('.mine-cal-row', { hasText: kind === 'series' ? 'Одни из нас' : 'Дюна' }).click();
            const card = page.locator('#mine-card-modal');
            const deletes = () => panel.account.sent.filter((r) => r.method === 'DELETE');
            await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
            await expect(card).toContainText('Release notifications will stop.');
            expect(deletes()).toHaveLength(0);
            await card.getByRole('button', { name: 'Keep following', exact: true }).click();
            await expect(card.locator('.mine-confirm')).toHaveCount(0);
            expect(deletes()).toHaveLength(0);
            await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
            await card.getByRole('button', { name: 'Yes, unfollow', exact: true }).click();
            await expect(card).toBeHidden();
            await expect(body).not.toContainText(kind === 'series' ? 'Одни из нас' : 'Дюна');
            expect(deletes().map((r) => r.path)).toEqual([
                `/api/account/chats/-100/${kind}/${kind === 'series' ? 'tv_100' : '7'}`
            ]);
            await openSection(page, 'my-subs');
            if (kind === 'films') await page.locator('[data-action="mine-subs-tab"][data-tab="films"]').click();
            await expect(page.locator('#my-subs-body')).not.toContainText(kind === 'series' ? 'Одни из нас' : 'Дюна');
        });
    }
});

test.describe('unfollow service outage', () => {
    watchConsole({ ignore: /status of 503/ });
    test('failed calendar unfollow keeps the card and can be retried', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        panel.account.unfollowError = true;
        await openSection(page, 'my-calendar');
        await page.locator('#my-calendar-body .mine-cal-row').first().click();
        const card = page.locator('#mine-card-modal');
        await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
        await card.getByRole('button', { name: 'Yes, unfollow', exact: true }).click();
        await expect(page.locator('.toast').last()).toContainText('Could not unfollow');
        await expect(card).toBeVisible();
        await expect(card.getByRole('button', { name: 'Yes, unfollow', exact: true })).toBeEnabled();
        panel.account.unfollowError = false;
        await card.getByRole('button', { name: 'Yes, unfollow', exact: true }).click();
        await expect(card).toBeHidden();
    });
});

test.describe('local title search', () => {
    watchConsole();
    test('quiet search filters each user page, closes with its cross/Escape, and Released is renamed', async ({
        page
    }) => {
        const panel = await mockPanel(page, { role: 'user' });
        for (const section of ['my-subs', 'my-calendar', 'my-aired']) {
            await openSection(page, section);
            const area = page.locator(`#${section}-section`);
            const toggle = area.getByRole('button', { name: 'Search titles', exact: true });
            const input = area.locator('[data-mine-filter]');
            await expect(input).toBeHidden();
            if (section === 'my-aired') await expect(area.locator('h1')).toHaveText('Released');
            await toggle.click();
            await expect(input).toBeFocused();
            const sentBeforeTyping = panel.account.sent.length;
            await input.fill('  ОДНИ  ');
            const rows = area.locator(section === 'my-aired' ? '.history-item:not(.history-filler)' : '.mine-row');
            await expect(rows).toHaveCount(1);
            await expect(rows).toContainText('Одни из нас');
            await input.fill('no-such-title');
            await expect(area).toContainText('No matching titles');
            expect(panel.account.sent.slice(sentBeforeTyping).some((r) => r.path.includes('/search'))).toBe(false);
            // The field covers the magnifier; its own cross closes it
            await expect(toggle).toBeHidden();
            await area.getByRole('button', { name: 'Close search', exact: true }).click();
            await expect(input).toBeHidden();
            await expect(rows).toHaveCount(2);
            await toggle.click();
            await input.fill('no-such-title');
            await input.press('Escape');
            await expect(input).toBeHidden();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(rows).toHaveCount(2);
        }
    });
});
