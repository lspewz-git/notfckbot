const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, pickChat } = require('./helpers');

const confirmUnfollow = (page) => page.locator('#confirm-modal').getByRole('button', { name: 'Unfollow', exact: true });

test.describe('shared cards and calendar unfollow', () => {
    watchConsole();

    test('a pending mode save blocks unfollow even after reopening the calendar card', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        let release;
        panel.account.modeHold = new Promise((resolve) => {
            release = resolve;
        });
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body button.title-row').first().click();
        const card = page.locator('#mine-card-modal');
        try {
            await card.getByRole('button', { name: /Notify me/ }).click();
            await card.getByText('When the whole season is out').click();
            await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toBeDisabled();
            await card.getByRole('button', { name: 'Close', exact: true }).click();
            await openSection(page, 'my-calendar');
            const episode = page.locator('#my-calendar-body button.cal-row').first();
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
        await confirmUnfollow(page).click();
        await expect(card).toBeHidden();
        await expect(page.locator('.toast').last()).toContainText('Unfollowed');
        expect(panel.account.series.some((item) => item.id === 'tv_100')).toBe(false);
    });

    test('notification mode can be changed in Following and is absent from Calendar', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        await openSection(page, 'my-calendar');
        await page.locator('#my-calendar-body button.cal-row').first().click();
        const card = page.locator('#mine-card-modal');
        await expect(card.locator('.mine-modes')).toHaveCount(0);
        expect(panel.account.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/series'))).toHaveLength(0);
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await openSection(page, 'my-subs');
        await page.locator('#my-subs-body button.title-row').first().click();
        await card.getByRole('button', { name: /Notify me/ }).click();
        await card.getByText('When the whole season is out').click();
        await expect(page.locator('.toast').last()).toContainText('Notifications changed');
        expect(panel.account.sent.find((r) => r.method === 'POST' && r.path.endsWith('/series')).body).toEqual({
            tmdbId: 'tv_100',
            mode: 'season'
        });
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await openSection(page, 'my-calendar');
        await page.locator('#my-calendar-body button.cal-row').first().click();
        await expect(card.locator('.mine-modes')).toHaveCount(0);
    });

    test('Following and Calendar share the title card: rows without data are left out', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        panel.account.calendar.items.filter(item => item.kind === 'movie' && item.overview).forEach(item => { item.overview = 'A long calendar overview. '.repeat(100); });
        await openSection(page, 'my-subs');
        await expect(page.locator('#my-subs-section h1')).toHaveText('Following');
        await page.locator('[data-action="mine-subs-tab"][data-tab="films"]').click();
        await page.locator('#my-subs-body button.title-row').click();
        const card = page.locator('#mine-card-modal');
        await expect(card.locator('.tc-head h2')).toBeVisible();
        // A film: in cinemas and online, two date blocks
        await expect(card.locator('.tc-date')).toHaveCount(2);
        await expect(card.locator('.tc-date').first()).toContainText('6 Nov 2026');
        await expect(card.locator('.tc-overview')).toBeVisible();
        await card.locator('.title-sheet').evaluate(el => Promise.all(el.getAnimations().map(animation=>animation.finished)));
        const gap = await card.evaluate((el) => {
            const above = el.querySelector('.tc-link').getBoundingClientRect();
            return el.querySelector('.tc-actions').getBoundingClientRect().top - above.bottom;
        });
        expect(gap).toBe(8);
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await openSection(page, 'my-calendar');
        await page.locator('[data-action="mine-cal-what"][data-what="films"]').click();
        await page.locator('#my-calendar-body button.cal-row', { hasText: 'Дюна' }).click();
        await expect(card.locator('.tc-head h2')).toHaveText('Дюна: Часть третья');
        await expect(card.locator('.tc-rating')).toContainText('7.4');
        // A long overview fills the available space; its inline link reveals the rest.
        const more = card.getByRole('button', { name: 'Show more', exact: true });
        await expect(more).toBeVisible();
        await more.click();
        await expect(card.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute(
            'aria-expanded',
            'true'
        );
    });

    test('the calendar bell marks the days the bot writes, and the card says when', async ({ page }) => {
        await mockPanel(page, { role: 'user' });
        await openSection(page, 'my-calendar');
        const rows = page.locator('#my-calendar-body button.cal-row');
        await expect(rows.filter({ hasText: 'Одни из нас' }).locator('.cal-bell')).toHaveCount(1);
        await expect(rows.filter({ hasText: 'Gone Show' }).locator('.cal-bell')).toHaveCount(0);
        await rows.filter({ hasText: 'Одни из нас' }).click();
        const card = page.locator('#mine-card-modal');
        await expect(card.locator('.tc-date .tc-bell')).toHaveCount(1);
        await expect(card.locator('.tc-date')).toContainText('The bot messages you on Nov 5');
        // Only the day is known: a quieter line says why the message waits, under the note
        const hint = card.locator('.tc-date .tc-date-hint');
        await expect(hint).toHaveText('No release hour is announced, so the message comes after the day ends.');
        await card
            .locator('.title-sheet')
            .evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
        const [noteBox, hintBox] = await Promise.all([
            card.locator('.tc-date .tc-date-label').last().boundingBox(),
            hint.boundingBox()
        ]);
        // Below the note, not beside it (subpixel rounding on the phone: within 1px)
        expect(hintBox.y).toBeGreaterThan(noteBox.y + noteBox.height - 1);
        await expect(card.getByRole('link', { name: 'Watch on SSPoisk' })).toBeVisible();
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
            await body.locator('button.cal-row', { hasText: kind === 'series' ? 'Одни из нас' : 'Дюна' }).click();
            const card = page.locator('#mine-card-modal');
            const confirm = page.locator('#confirm-modal');
            const deletes = () => panel.account.sent.filter((r) => r.method === 'DELETE');
            await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
            await expect(confirm).toContainText('Release notifications will stop.');
            expect(deletes()).toHaveLength(0);
            await confirm.getByRole('button', { name: 'Keep following', exact: true }).click();
            await expect(confirm).toBeHidden();
            await expect(card).toBeVisible();
            expect(deletes()).toHaveLength(0);
            await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
            await confirmUnfollow(page).click();
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
    test('a failed unfollow shows the error on the card, which stays and can retry', async ({ page }) => {
        const panel = await mockPanel(page, { role: 'user' });
        panel.account.unfollowError = true;
        await openSection(page, 'my-calendar');
        await page.locator('#my-calendar-body button.cal-row').first().click();
        const card = page.locator('#mine-card-modal');
        await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
        await confirmUnfollow(page).click();
        await expect(card.locator('#mine-card-error')).toContainText('Could not unfollow');
        await expect(card).toBeVisible();
        await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toBeEnabled();
        panel.account.unfollowError = false;
        await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
        await confirmUnfollow(page).click();
        await expect(card).toBeHidden();
    });
});

test.describe('the title search page', () => {
    watchConsole();
    test('the search pill opens it from each tab; Back returns there; results Follow or show Following', async ({
        page
    }) => {
        const panel = await mockPanel(page, { role: 'user' });
        for (const section of ['my-calendar', 'my-aired', 'my-subs']) {
            await openSection(page, section);
            await page.locator(`#${section}-section .search-pill`).click();
            await expect(page.locator('#my-search-section')).toHaveClass(/active/);
            await expect(page.locator('#mine-q')).toBeFocused();
            await expect(page.locator('#mine-results')).toContainText('Find a series or film');
            await page.locator('#mine-search-back').click();
            await expect(page.locator(`#${section}-section`)).toHaveClass(/active/);
        }
        // Following's "+" opens it too; typing searches after a pause
        await page.getByRole('link', { name: 'Follow a title' }).click();
        await page.locator('#mine-q').fill('Дюна');
        await expect(page.locator('#mine-results .search-row')).toHaveCount(3);
        expect(panel.account.sent.filter((r) => r.path.includes('/search'))).toHaveLength(1);
        await expect(page.locator('#mine-results .search-row', { hasText: 'Часть третья' })).toContainText(
            'Following'
        );
        // The clear cross empties the field and the results
        await page.getByRole('button', { name: 'Clear search', exact: true }).click();
        await expect(page.locator('#mine-q')).toHaveValue('');
        await expect(page.locator('#mine-results')).toContainText('Find a series or film');
        // A series' Follow opens its sheet with Notify me; Follow there subscribes
        await page.locator('#mine-q').fill('Дюна');
        await page.getByRole('button', { name: 'Follow Дюна: Пророчество', exact: true }).click();
        const card = page.locator('#mine-card-modal');
        await expect(card.locator('.tc-notify')).toBeVisible();
        await expect(card.locator('.tc-rating')).toContainText('7.1');
        await card.getByRole('button', { name: /Notify me/ }).click();
        await card.getByText('Episode 1 and the whole season').click();
        await card.getByRole('button', { name: 'Follow', exact: true }).click();
        await expect(card).toBeHidden();
        expect(panel.account.sent.find((r) => r.method === 'POST' && r.path.endsWith('/series')).body).toEqual({
            tmdbId: 'tv_500',
            mode: 'first_and_full'
        });
        await expect(page.locator('#mine-results .search-row', { hasText: 'Пророчество' })).toContainText(
            'Following'
        );
    });
});
