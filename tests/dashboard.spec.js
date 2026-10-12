const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * The dashboard's own behaviour, on the canned API: service statuses and the error
 * banner, "Run now" following a check to its end, and the remembered auto-refresh switch.
 */

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.__errors = errors;
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'console should stay clean').toEqual([]);
});

test('statuses read "TG" when fine, "KP: ERR" and "Proxy: OFF" otherwise; no banner while all is well', async ({
    page
}) => {
    await mockPanel(page);
    await expect(page.locator('#health-tg')).toHaveText('TG');
    await expect(page.locator('#health-kp')).toHaveText('KP');
    await expect(page.locator('#health-proxy')).toHaveText('Proxy: OFF');
    await expect(page.locator('#service-alert')).toBeHidden();
});

test('a failing service raises the banner, and "View logs" opens the logs', async ({ page }) => {
    await mockPanel(page, { health: { kinopoisk: 'error', tmdb: false } });
    await expect(page.locator('#health-kp')).toHaveText('KP: ERR');
    await expect(page.locator('#service-alert')).toBeVisible();
    await expect(page.locator('#service-alert-text')).toHaveText('TMDB and KP are reporting errors');

    await page.locator('#service-alert .alert-action').click();
    await expect(page.locator('#logs-section')).toHaveClass(/active/);
});

test('the banner is not rewritten when a refresh brings the same news', async ({ page }) => {
    await mockPanel(page, { health: { kinopoisk: 'error' } });
    await expect(page.locator('#service-alert-text')).toHaveText('KP is reporting an error');

    // The banner is a live region: any rewrite would be read out again
    await page.evaluate(() => {
        window.__bannerWrites = 0;
        new MutationObserver(() => window.__bannerWrites++).observe(document.getElementById('service-alert-text'), {
            childList: true,
            characterData: true,
            subtree: true
        });
    });
    const refresh = page.waitForResponse('**/api/health/kinopoisk');
    await page.locator('#refresh-btn').click();
    await refresh;
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__bannerWrites)).toBe(0);
});

test('"Run now" waits for the check and then shows its result', async ({ page }) => {
    await mockPanel(page);
    const run = page.locator('#run-check');
    await expect(page.locator('#cron-last')).toHaveText('No check since the bot started');

    await run.click();
    await expect(run).toBeDisabled();
    await expect(run).toHaveText('Running…');

    await expect(run).toHaveText('Run now', { timeout: 15_000 });
    await expect(run).toBeEnabled();
    await expect(page.locator('#cron-state')).toHaveText('OK');
    await expect(page.locator('#cron-checked')).toHaveText('11 series, 6 films');
    await expect(page.locator('#cron-sent')).toHaveText('2 sent');
});

test('the auto-refresh switch is remembered across reloads', async ({ page }) => {
    await mockPanel(page);
    const sw = page.locator('#auto-refresh');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
});

const listHeights = (page) =>
    page.evaluate(() =>
        ['upcoming-list', 'popular-list'].map((id) => document.getElementById(id).getBoundingClientRect().height)
    );

/** Five rows in each list, like a populated server */
function fullLists() {
    const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
    const upcoming = [1, 2, 30, 40, 50].map((n, i) => ({
        kind: i % 2 ? 'movie' : 'tv',
        id: String(n),
        title: `Title ${n}`,
        episode: 'S1E2',
        date: day(n),
        chats: 1
    }));
    const popular = [1, 2, 3, 4, 5].map((n) => ({
        seriesId: String(n),
        subCount: n,
        Series: { tmdb_id: String(n), title: `Series ${n}` }
    }));
    return { upcoming, popular };
}

async function loadedHeights(page) {
    await expect(page.locator('#upcoming-list .upcoming-row:not(.skeleton-item)')).toHaveCount(5);
    await expect(page.locator('#popular-list .popular-item:not(.skeleton-item)')).toHaveCount(5);
    return listHeights(page);
}

const expectSame = (a, b) => a.forEach((h, i) => expect(Math.abs(h - b[i])).toBeLessThanOrEqual(1));

test('the dashboard cards keep their height when the data replaces the placeholders', async ({ page }) => {
    let release;
    const hold = new Promise((r) => (release = r));
    await mockPanel(page, { ...fullLists(), hold });

    await expect(page.locator('#upcoming-list .skeleton-item')).toHaveCount(5);
    const placeholders = await listHeights(page);
    release();
    expectSame(placeholders, await loadedHeights(page));
});

test('the dashboard cards have their final height before the scripts run, and with nothing to list', async ({
    page
}) => {
    // The first paint can come before the deferred app module: the lists are still empty then
    await page.route('**/js/app.js', (r) => r.abort());
    await mockPanel(page);
    const beforeScripts = await listHeights(page);
    page.__errors.length = 0; // the aborted module is reported as a console error

    await page.unroute('**/js/app.js');
    await mockPanel(page, fullLists());
    const loaded = await loadedHeights(page);
    expectSame(beforeScripts, loaded);

    await mockPanel(page, { upcoming: [], popular: [] });
    await expect(page.locator('#upcoming-list .empty-note')).toBeVisible();
    expectSame(await listHeights(page), loaded);
});

test('the deployed commit is shown under the title, linked to GitHub', async ({ page }) => {
    await mockPanel(page);
    const info = page.locator('#build-info');
    await expect(info).toContainText('Version abc1234');
    await expect(info).toHaveAttribute('title', 'Test commit');
    const link = info.getByRole('link', { name: 'Commit abc1234 on GitHub' });
    await expect(link).toHaveAttribute('href', /github\.com\/owner\/repo\/commit\/abc1234/);
    await expect(link).toHaveAttribute('target', '_blank');
});

test('the version line goes away when the server has no .git to read', async ({ page }) => {
    // The line starts hidden, so it has to be shown first for its hiding to prove anything
    const options = {};
    await mockPanel(page, options);
    await expect(page.locator('#build-info')).toBeVisible();

    options.version = { commit: null, short: null, subject: null, date: null, url: null };
    await page.locator('#refresh-btn').click();
    await expect(page.locator('#build-info')).toBeHidden();
});
