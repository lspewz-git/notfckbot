const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/** Settings: the server's .env as fields, saved all at once, and the restart button. */

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.__errors = errors;
});

test.afterEach(async ({ page }) => {
    // A refused save or restart is a 4xx the browser reports itself
    const real = page.__errors.filter((e) => !/status of 4\d\d/.test(e));
    expect(real, 'console should stay clean').toEqual([]);
});

/** The rail on a wide screen; on a phone, More → Settings. */
async function openSettings(page) {
    const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
    if (narrow) {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator('#more-modal [data-section="settings"]').click();
    } else {
        await page.locator('.nav-item[data-section="settings"]').click();
    }
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    await expect(page.locator('#settings-masked-telegram')).toHaveText('8123*****xYz4');
}

const bar = (page) => page.locator('#settings-bar-text');

/** Picks an option of a styled select, as a user would. */
async function pick(page, selectId, text) {
    await page.locator(`.custom-select:has(#${selectId}) .custom-select-trigger`).click();
    await page.locator('.custom-select-panel .custom-select-option', { hasText: text }).first().click();
}

test('the saved values: tokens masked, the interval, the database read only; nothing to save yet', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await expect(page.locator('#settings-masked-kinopoisk')).toHaveText('Not set');
    await expect(page.locator('#settings-interval')).toHaveValue('3');
    await expect(page.locator('#settings-db-name')).toHaveText('series_bot');
    // The database has no fields to change
    await expect(page.locator('#settings-section dl input')).toHaveCount(0);
    await expect(bar(page)).toHaveText('No changes');
    await expect(page.locator('#settings-proxy-fields')).toBeHidden();
});

test('a change is marked and counted; Discard puts the saved values back', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await pick(page, 'settings-interval', '6 hours');
    await expect(bar(page)).toHaveText('1 unsaved change');
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await page.locator('#settings-token-tmdb').fill('eyJabc.def.ghi');
    await expect(bar(page)).toHaveText('2 unsaved changes');
    await expect(page.locator('#settings-token-tmdb')).toHaveAttribute('data-dirty', 'true');

    await page.locator('[data-action="settings-discard"]').click();
    await expect(bar(page)).toHaveText('No changes');
    await expect(page.locator('#settings-interval')).toHaveValue('3');
    await expect(page.locator('#settings-token-tmdb')).toBeHidden();
});

test('Save sends only what changed, all at once; the interval then waits for a restart', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await pick(page, 'settings-interval', '6 hours');
    await page.locator('[data-action="settings-replace"][data-service="kinopoisk"]').click();
    await page.locator('#settings-token-kinopoisk').fill('1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f');
    await page.locator('[data-action="settings-save"]').click();

    await expect(page.locator('.toast-success')).toContainText('Saved 2 settings');
    expect(panel.lastSettingsSave).toEqual({
        tokens: { kinopoisk: '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f' },
        intervalHours: 6
    });
    await expect(bar(page)).toHaveText('No changes');
    await expect(page.locator('#settings-masked-kinopoisk')).toHaveText('new0*****cafe');
    await expect(page.locator('#settings-restart-text')).toHaveText('Waiting for a restart: the update interval.');
});

test('a value the server refuses: the field says why, and the edits stay for fixing', async ({ page }) => {
    await mockPanel(page, {
        settingsSave: () => ({
            status: 400,
            body: {
                error: 'Nothing was saved: fix the marked fields',
                fields: { tmdb: 'TMDB API rejected it: 401 Unauthorized' }
            }
        })
    });
    await openSettings(page);
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await page.locator('#settings-token-tmdb').fill('eyJabc.def.ghi');
    await page.locator('[data-action="settings-save"]').click();

    await expect(page.locator('#settings-error-tmdb')).toHaveText('TMDB API rejected it: 401 Unauthorized');
    await expect(page.locator('#settings-token-tmdb')).toHaveValue('eyJabc.def.ghi');
    await expect(bar(page)).toHaveText('1 unsaved change');
});

test('a proxy without a host and a port is not sent', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await expect(page.locator('#settings-proxy-fields')).toBeVisible();
    await page.locator('#settings-proxy-host').fill('10.0.0.5');
    await page.locator('[data-action="settings-save"]').click();
    await expect(page.locator('#settings-error-proxy')).toHaveText(
        'Fill in the host and the port, or set the mode to Off'
    );
    expect(panel.lastSettingsSave).toBeUndefined();

    await page.locator('#settings-proxy-port').fill('1080');
    await page.locator('[data-action="settings-save"]').click();
    await expect(page.locator('.toast-success')).toBeVisible();
    expect(panel.lastSettingsSave).toEqual({ proxyUrl: 'socks5h://10.0.0.5:1080' });
});

test('leaving with unsaved changes asks first: Stay keeps them, Discard leaves', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await pick(page, 'settings-interval', '12 hours');

    const leave = async () => {
        const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
        await page
            .locator(narrow ? '.tab-item[data-section="dashboard"]' : '.nav-item[data-section="dashboard"]')
            .click();
    };
    await leave();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#modal-cancel-btn').click();
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    await expect(page.locator('#settings-interval')).toHaveValue('12');

    await leave();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
});

test('restart: refused around an update check, with the time to come back', async ({ page }) => {
    const checkAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 8 * 60 * 1000).toISOString();
    const panel = await mockPanel(page, {
        settings: { restart: { pending: [], blocked: { reason: 'due', checkAt, until } } }
    });
    await openSettings(page);
    await page.locator('[data-action="settings-restart"]').click();
    await expect(page.locator('.toast-warning')).toContainText('An update check runs at');
    await expect(page.locator('#confirm-modal')).toBeHidden();
    expect(panel.restarted).toBeUndefined();
});

test('restart: the check just finished, seconds to wait: said in seconds, not as a past minute', async ({ page }) => {
    const checkAt = new Date(Date.now() - 40 * 1000).toISOString();
    const until = new Date(Date.now() + 20 * 1000).toISOString();
    await mockPanel(page, { settings: { restart: { pending: [], blocked: { reason: 'started', checkAt, until } } } });
    await openSettings(page);
    await page.locator('[data-action="settings-restart"]').click();
    await expect(page.locator('.toast-warning')).toContainText(/Restart in d+ s./);
});

test('restart: asks, then waits for the bot to answer again', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-restart"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Restart the bot?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast', { hasText: 'Restarting' })).toBeVisible();
    await expect(page.locator('.toast-success', { hasText: 'The bot is back' })).toBeVisible({ timeout: 10000 });
    expect(panel.restarted).toBe(true);
});

test("a proxy on its scheme's default port reads back whole: no change shown on opening", async ({ page }) => {
    await mockPanel(page, { settings: { proxy: { url: 'http://proxy.lan', hasPassword: false } } });
    await openSettings(page);
    await expect(page.locator('#settings-proxy-port')).toHaveValue('80');
    await expect(bar(page)).toHaveText('No changes');
});

test('a refresh does not close a token field opened for pasting', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await expect(page.locator('#settings-token-tmdb')).toBeVisible();
    // The server's restart state changes meanwhile; the open field stays, the new state shows
    panel.settings.restart.pending = ['interval'];
    const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
    if (narrow) {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator('#more-modal [data-section="settings"]').click();
    } else {
        await page.locator('.nav-item[data-section="settings"]').click();
    }
    await expect(page.locator('#settings-restart-text')).toContainText('the update interval');
    await expect(page.locator('#settings-token-tmdb')).toBeVisible();
});

test('Services and Proxy on the left, the rest on the right; both columns end on one line', async ({ page }) => {
    test.skip((page.viewportSize() || { width: 1280 }).width < 1024, 'one column on a phone');
    await mockPanel(page);
    await openSettings(page);
    const columns = async () =>
        page.locator('.settings-col').evaluateAll((cols) =>
            cols.map((col) => ({
                titles: [...col.querySelectorAll('.settings-title')].map((t) => t.firstChild.textContent.trim()),
                bottom: Math.round(col.lastElementChild.getBoundingClientRect().bottom)
            }))
        );
    const [left, right] = await columns();
    expect(left.titles).toEqual(['Services', 'Proxy']);
    expect(right.titles).toEqual(['Update check', 'Database', 'Bot']);
    expect(left.bottom).toBe(right.bottom);
    // A proxy turned on makes the left column taller: the right one follows
    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await expect(page.locator('#settings-proxy-fields')).toBeVisible();
    const [left2, right2] = await columns();
    expect(left2.bottom).toBe(right2.bottom);
});

test('Restart sits under its description', async ({ page }) => {
    test.skip((page.viewportSize() || { width: 1280 }).width < 1024, 'one column on a phone');
    await mockPanel(page);
    await openSettings(page);
    const [card, button] = await Promise.all([
        page.locator('.settings-card:has(#settings-restart)').boundingBox(),
        page.locator('#settings-restart').boundingBox()
    ]);
    // On the card's left padding, not out in a field column
    expect(button.x - card.x).toBeLessThan(40);
});

test('the bot card says since when the bot runs, not a vague "running"', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await expect(page.locator('#settings-restart-text')).toContainText(/^Running since today, \d{1,2}:\d{2}/);
    await expect(page.locator('#settings-restart-text')).toHaveText(/^Running since today, \d{1,2}:\d{2}( [AP]M)?\.$/);
});

test('Test shows each target in the card; changing the proxy clears the old result', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-proxy-test"]').click();
    await expect(page.locator('[data-check="telegram"]')).toHaveText('✓ 180 ms');
    await expect(page.locator('[data-check="internet"]')).toHaveText('✓ 95 ms · IP 203.0.113.7');
    await expect(page.locator('#settings-checks-when')).toContainText('Through the proxy');

    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await expect(page.locator('[data-check="telegram"]')).toHaveText('—');
    await expect(page.locator('#settings-checks-when')).toHaveText('Press Test to check');
});

test('a refresh keeps the connection check; Discard of a proxy change clears it', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-proxy-test"]').click();
    await expect(page.locator('[data-check="telegram"]')).toHaveText('✓ 180 ms');

    // The same section again: a reload of the saved values, as the auto-refresh does
    const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
    if (narrow) {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator('#more-modal [data-section="settings"]').click();
    } else {
        await page.locator('.nav-item[data-section="settings"]').click();
    }
    await page.waitForTimeout(300);
    await expect(page.locator('[data-check="telegram"]')).toHaveText('✓ 180 ms');

    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await page.locator('#settings-proxy-host').fill('10.0.0.5');
    await page.locator('#settings-proxy-port').fill('1080');
    await page.locator('[data-action="settings-proxy-test"]').click();
    await expect(page.locator('#settings-checks-when')).toContainText('Through the proxy');
    await page.locator('[data-action="settings-discard"]').click();
    await expect(page.locator('#settings-checks-when')).toHaveText('Press Test to check');
});

test('while the settings load, nothing shows that would then jump away', async ({ page }) => {
    let release;
    const hold = new Promise((resolve) => {
        release = resolve;
    });
    await mockPanel(page, { hold });
    const narrow = (page.viewportSize() || { width: 1280 }).width < 1024;
    if (narrow) {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator('#more-modal [data-section="settings"]').click();
    } else {
        await page.locator('.nav-item[data-section="settings"]').click();
    }
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    // The answer is held: the proxy fields stay hidden, as they will be with no proxy saved
    await expect(page.locator('#settings-proxy-fields')).toBeHidden();
    const before = await page.locator('#settings-restart-text').boundingBox();
    release();
    await expect(page.locator('#settings-masked-telegram')).toHaveText('8123*****xYz4');
    await expect(page.locator('#settings-proxy-fields')).toBeHidden();
    expect((await page.locator('#settings-restart-text').boundingBox()).height).toBe(before.height);
});
