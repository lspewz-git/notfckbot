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

test("a failing service raises the banner, and its button opens that service's dialog", async ({ page }) => {
    await mockPanel(page, { health: { kinopoisk: 'error', tmdb: false } });
    await expect(page.locator('#health-kp')).toHaveText('KP: ERR');
    await expect(page.locator('#service-alert')).toBeVisible();
    await expect(page.locator('#service-alert-text')).toHaveText('TMDB and KP are reporting errors');

    // The first failing service: the same dialog its badge opens
    const action = page.locator('#service-alert-action');
    await expect(action).toHaveText('Open TMDB');
    await page.route('**/api/services/tmdb*', (route) =>
        route.fulfill({
            json: {
                name: 'tmdb',
                label: 'TMDB API',
                configured: true,
                masked: 'abcd*****wxyz',
                statusUrl: 'https://status.themoviedb.org',
                statusLabel: 'Status page'
            }
        })
    );
    await page.route('**/api/services/tmdb/check', (route) =>
        route.fulfill({ json: { configured: true, ok: false, details: [], checkError: 'HTTP 401', status: 401 } })
    );
    await action.click();
    await expect(page.locator('#service-modal')).toBeVisible();
    await expect(page.locator('#service-title')).toHaveText('TMDB API');
});

test('the version footer is only as wide as its text', async ({ page }) => {
    await mockPanel(page);
    const footer = page.locator('#build-info');
    await expect(footer).toBeVisible();
    const width = await footer.evaluate((el) => el.getBoundingClientRect().width);
    const section = await page.locator('#dashboard-section').evaluate((el) => el.getBoundingClientRect().width);
    // Stretched it would be the section's full width; its text is far shorter on any screen
    expect(width).toBeLessThan(section * 0.8);
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
    await expect(page.locator('#cron-duration')).toHaveText('—');

    await run.click();
    await expect(run).toBeDisabled();
    await expect(run).toHaveText('Running…');
    await expect(page.locator('#cron-duration')).toHaveText(/^\d+ s so far$/);

    await expect(run).toHaveText('Run now', { timeout: 15_000 });
    await expect(run).toBeEnabled();
    await expect(page.locator('#cron-state')).toHaveText('OK');
    await expect(page.locator('#cron-checked')).toHaveText('11 series, 6 films');
    await expect(page.locator('#cron-sent')).toHaveText('2 sent');
    await expect(page.locator('#cron-duration')).toHaveText('4 s');
    await expect(page.locator('#cron-last')).toHaveText(/^\d+ s ago$/);
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
    // The first paint can come before the app module: only the page's own placeholders then.
    // Not awaited: the page's load waits for the held module
    let release;
    const scripts = new Promise((r) => (release = r));
    const opened = mockPanel(page, { ...fullLists(), files: { 'js/app.js': scripts } });
    await expect(page.locator('#upcoming-list .skeleton-item')).toHaveCount(5);
    const beforeScripts = await listHeights(page);

    release();
    await opened;
    const loaded = await loadedHeights(page);
    expectSame(beforeScripts, loaded);

    await mockPanel(page, { upcoming: [], popular: [] });
    await expect(page.locator('#upcoming-list .empty-note')).toBeVisible();
    expectSame(await listHeights(page), loaded);
});

test('the placeholders are in the page itself: they show before any script has run', async ({ page }) => {
    // The panel's script and Chart.js held back: what the first paint shows. Not awaited: the
    // page's load waits for them
    let release;
    const scripts = new Promise((r) => (release = r));
    const opened = mockPanel(page, { files: { 'js/app.js': scripts, 'vendor/chart.umd.js': scripts } });
    await expect(page.locator('.stat-value .skeleton')).toHaveCount(6);
    await expect(page.locator('#upcoming-list .skeleton-item')).toHaveCount(5);
    await expect(page.locator('#popular-list .skeleton-item')).toHaveCount(5);
    await expect(page.locator('.chart-box .chart-skeleton')).toHaveCount(2);
    for (const el of await page.locator('.stat-value .skeleton, .chart-skeleton').all()) await expect(el).toBeVisible();
    const cards = await page.locator('.stat-card').evaluateAll((els) => els.map((e) => e.offsetHeight));

    release();
    await opened;
    await expect(page.locator('.stat-value .skeleton')).toHaveCount(0);
    // A number in place of its bar: the cards keep their height
    expect(await page.locator('.stat-card').evaluateAll((els) => els.map((e) => e.offsetHeight))).toEqual(cards);
    await expect(page.locator('.chart-skeleton')).toHaveCount(0);
});

test("the page's placeholder rows have the shape of the rows that replace them", async ({ page }) => {
    // The row's parts and the body's lines (what sets the height), not the text that fills them
    const shape = (selector) =>
        page
            .locator(selector)
            .first()
            .evaluate((row) => {
                const walk = (el) =>
                    [...el.children]
                        .filter((c) => !c.classList.contains('skeleton') && c.tagName !== 'svg')
                        .map(
                            (c) => `${c.tagName}.${[...c.classList].join('.')}(${c.matches('.up-body') ? walk(c) : ''})`
                        )
                        .join(',');
                return `${row.tagName}.${[...row.classList].filter((c) => c !== 'skeleton-item').join('.')}(${walk(row)})`;
            });
    let release;
    const hold = new Promise((r) => (release = r));
    await mockPanel(page, { ...fullLists(), hold });
    const placeholders = [await shape('#upcoming-list .skeleton-item'), await shape('#popular-list .skeleton-item')];
    release();
    await loadedHeights(page);
    expect([await shape('#upcoming-list .upcoming-row'), await shape('#popular-list .popular-item')]).toEqual(
        placeholders
    );
});

test('Chart.js coming after the data: the charts draw when it does; not coming at all: no bars left', async ({
    page
}) => {
    let release;
    const late = new Promise((r) => (release = r));
    // Not awaited: the page's load event waits for Chart.js too
    const opened = mockPanel(page, { files: { 'vendor/chart.umd.js': late } });
    await expect(page.locator('#sent-count')).toHaveText(/\d/);
    await expect(page.locator('.chart-skeleton')).toHaveCount(2);
    release();
    await opened;
    await expect
        .poll(() =>
            page.evaluate(() => Boolean(window.Chart && window.Chart.getChart(document.getElementById('chart-sent'))))
        )
        .toBe(true);
    await expect(page.locator('.chart-skeleton')).toHaveCount(0);

    await mockPanel(page, { files: { 'vendor/chart.umd.js': 'missing' } });
    await expect(page.locator('.chart-skeleton')).toHaveCount(0);
    page.__errors.length = 0;
});

test('a dashboard request failing on the first load: a dash, no chart bars, a note; no shimmer left', async ({
    page
}) => {
    const failing = ['/api/stats', '/api/stats/charts', '/api/upcoming', '/api/stats/popular'];
    const options = { failing };
    await mockPanel(page, options);
    await expect(page.locator('#sent-count')).toHaveText('-');
    await expect(page.locator('.chart-skeleton')).toHaveCount(0);
    await expect(page.locator('#upcoming-list .empty-note')).toHaveText(/Failed to load/);
    await expect(page.locator('#popular-list .empty-note')).toHaveText(/Failed to load/);
    await expect(page.locator('.skeleton')).toHaveCount(0);
    page.__errors.length = 0; // the failed requests are logged

    // The next refresh fills them in
    failing.length = 0;
    await page.locator('#refresh-btn').click();
    await expect(page.locator('#sent-count')).toHaveText(/\d/);
    await expect(page.locator('#popular-list .popular-item')).not.toHaveCount(0);
});

test('the deployed commit is shown in the footer, linked to GitHub', async ({ page }) => {
    await mockPanel(page);
    const info = page.locator('#dashboard-section > footer:last-child');
    await expect(info).toHaveId('build-info');
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

test('auto-refresh counts down next to the switch and turns the refresh icon when it reloads', async ({ page }) => {
    await mockPanel(page);
    let statsRequests = 0;
    page.on('request', (r) => r.url().endsWith('/api/stats') && statsRequests++);
    const sw = page.locator('#auto-refresh');
    const countdown = page.locator('#refresh-countdown');
    await expect(countdown).toHaveText('');
    const widthOff = (await sw.boundingBox()).width;

    await sw.click();
    await expect(countdown).toHaveText('10 s');
    expect((await sw.boundingBox()).width, 'turning it on moves nothing').toBe(widthOff);
    await expect(countdown).toHaveText('9 s');

    const before = statsRequests;
    await expect(page.locator('#refresh-btn')).toHaveClass(/spinning/, { timeout: 12_000 });
    await expect(countdown).toHaveText('10 s');
    expect(statsRequests).toBeGreaterThan(before);

    await sw.click();
    await expect(countdown).toHaveText('');
});

test('a refresh pressed while one is running joins it instead of sending everything twice', async ({ page }) => {
    await mockPanel(page);
    // Settle the first load, then slow the next stats answer down
    await expect(page.locator('#health-tg')).toHaveText('TG');
    let statsRequests = 0;
    await page.route('**/api/stats', async (route) => {
        statsRequests++;
        await new Promise((r) => setTimeout(r, 1500));
        await route.fallback();
    });

    const btn = page.locator('#refresh-btn');
    await btn.click();
    await expect(btn).toHaveClass(/spinning/);
    await btn.click();
    await btn.click();
    await expect(btn).not.toHaveClass(/spinning/, { timeout: 5000 });
    expect(statsRequests).toBe(1);
});

test('the series card says how often the check runs, from the server', async ({ page }) => {
    await mockPanel(page, { intervalHours: 6 });
    await expect(page.locator('#series-interval')).toHaveText('Checked every 6 hours');
    await mockPanel(page, { intervalHours: 1 });
    await page.reload();
    await expect(page.locator('#series-interval')).toHaveText('Checked every hour');
});

test('the cards: each number with its change, green for good news, amber for the rest', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#chats-delta')).toHaveText('+2 new in 30 days');
    await expect(page.locator('#chats-delta')).toHaveClass(/delta-good/);
    await expect(page.locator('#films-delta')).toHaveText('−3 in 30 days');
    await expect(page.locator('#films-delta')).toHaveClass(/delta-bad/);
    await expect(page.locator('#sent-count')).toHaveText('38');
    await expect(page.locator('#sent-delta')).toHaveText('−12 from the week before');
    await expect(page.locator('#sent-delta')).toHaveClass(/delta-bad/);
    // Fewer undelivered is the good direction
    await expect(page.locator('#failed-delta')).toHaveText('−2 from the week before');
    await expect(page.locator('#failed-delta')).toHaveClass(/delta-good/);
    // The amber is the logo's
    const [amber, accent] = await page.evaluate(() => [
        getComputedStyle(document.querySelector('#films-delta')).color,
        getComputedStyle(document.querySelector('.rail-logo')).backgroundColor
    ]);
    expect(amber).toBe(accent);
});

test('nothing changed: said in words, in grey', async ({ page }) => {
    await mockPanel(page, { stats: { chatsNew30: 0, sent7: 10, sentPrev7: 10 } });
    await expect(page.locator('#chats-delta')).toHaveText('None new in 30 days');
    await expect(page.locator('#sent-delta')).toHaveText('Same as the week before');
    await expect(page.locator('#sent-delta')).toHaveClass(/delta-flat/);
    // The same small type as a change with an arrow
    const sizes = await page.evaluate(() =>
        ['#chats-delta', '#films-delta'].map((s) => getComputedStyle(document.querySelector(s)).fontSize)
    );
    expect(sizes[0]).toBe(sizes[1]);
});

test('six cards fill their rows with no gap: one row wide, three per row narrower, two on a phone', async ({
    page
}) => {
    await mockPanel(page);
    await expect(page.locator('#sent-count')).toHaveText('38');
    const rows = await page.locator('.stats-grid .stat-card').evaluateAll((cards) => {
        const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
        return [...new Set(tops)].map((t) => tops.filter((x) => x === t).length);
    });
    const width = (page.viewportSize() || { width: 1280 }).width;
    expect(rows).toEqual(width < 768 ? [2, 2, 2] : width <= 1380 ? [3, 3] : [6]);
});

test('the charts draw, and the subscriptions one switches between weeks and months', async ({ page }) => {
    await mockPanel(page);
    const chart = (id) =>
        page.evaluate((cid) => {
            const c = window.Chart && window.Chart.getChart(document.getElementById(cid));
            return c ? { labels: c.data.labels.length, sets: c.data.datasets.map((d) => d.label) } : null;
        }, id);
    await expect.poll(() => chart('chart-subs')).toEqual({ labels: 12, sets: ['New subscriptions'] });
    expect(await chart('chart-sent')).toEqual({ labels: 30, sets: ['Sent', 'Not delivered'] });
    await expect(page.locator('#chart-sent-note')).toHaveText(/^Counting since/);

    await page.locator('[data-action="chart-subs"][data-by="months"]').click();
    await expect(page.locator('[data-action="chart-subs"][data-by="months"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#chart-subs')).toHaveAttribute('aria-label', 'New subscriptions per month');
});

test('the charts and the lists line up with the cards: every edge between blocks is one between cards', async ({
    page
}) => {
    await mockPanel(page);
    await expect(page.locator('#sent-count')).toHaveText('38');
    const edges = await page.evaluate(() => {
        const sides = (sel) =>
            [...document.querySelectorAll(sel)].flatMap((el) => {
                const r = el.getBoundingClientRect();
                return [Math.round(r.left), Math.round(r.right)];
            });
        return { cards: sides('.stats-grid .stat-card'), others: sides('.charts-row > *, .dash-row > *') };
    });
    for (const x of edges.others) {
        expect(
            edges.cards.some((c) => Math.abs(c - x) <= 1),
            `edge at ${x}`
        ).toBe(true);
    }
});

test('the charts and the lists below split at the same line', async ({ page }) => {
    test.skip((page.viewportSize() || { width: 1280 }).width < 768, 'one column on a phone');
    // Wide enough for six cards in a row, where the two rows used to split apart
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockPanel(page);
    await expect(page.locator('#sent-count')).toHaveText('38');
    const [charts, lists] = await page.evaluate(() =>
        ['.charts-row > :first-child', '.dash-row > :first-child'].map((s) =>
            Math.round(document.querySelector(s).getBoundingClientRect().right)
        )
    );
    expect(charts).toBe(lists);
});

test('on a tablet the charts and the lists stand one under another, full width', async ({ page }) => {
    test.skip((page.viewportSize() || { width: 1280 }).width < 768, 'phone: covered by the layout tests');
    await page.setViewportSize({ width: 820, height: 1100 });
    await mockPanel(page);
    await expect(page.locator('#sent-count')).toHaveText('38');
    const widths = await page
        .locator('.charts-row > *, .dash-row > *')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(new Set(widths).size, String(widths)).toBe(1);
});
