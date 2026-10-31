const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, openSettingsTab } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/** Settings: the server's .env as fields in three tabs, each card saved on its own, and the restart button. */

// A refused save or restart is a 4xx the browser reports itself
watchConsole({ ignore: /status of 4\d\d/ });

/** The rail on a wide screen; on a phone, More → Settings. */
async function openSettings(page) {
    await openSection(page, 'settings');
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    await expect(page.locator('#settings-masked-telegram')).toHaveText('8123*****xYz4');
}

/** A card's unsaved-changes line ("2 unsaved changes"), shown only while it has some. */
const foot = (page, card) => page.locator(`#settings-foot-${card}`);
const footText = (page, card) => foot(page, card).locator('.settings-foot-text');
const saveCard = (page, card) => page.locator(`[data-action="settings-save"][data-card="${card}"]`);

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
    await expect(page.locator('.settings-foot:not([hidden])')).toHaveCount(0);
    await expect(page.locator('#settings-proxy-fields')).toBeHidden();
});

test('a change is marked and counted in its own card; Discard there puts back only that card', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await page.locator('#settings-token-tmdb').fill('eyJabc.def.ghi');
    await expect(footText(page, 'services')).toHaveText('1 unsaved change');
    await expect(foot(page, 'proxy')).toBeHidden();
    await expect(page.locator('#settings-token-tmdb')).toHaveAttribute('data-dirty', 'true');
    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await page.locator('#settings-proxy-host').fill('10.0.0.5');
    await expect(footText(page, 'proxy')).toHaveText('2 unsaved changes');

    await foot(page, 'services').locator('[data-action="settings-discard"]').click();
    await expect(foot(page, 'services')).toBeHidden();
    await expect(page.locator('#settings-token-tmdb')).toBeHidden();
    // The proxy's edits are still there
    await expect(page.locator('#settings-proxy-host')).toHaveValue('10.0.0.5');
    await expect(footText(page, 'proxy')).toHaveText('2 unsaved changes');
});

test("a card's Save sends only its fields; the other card's edits stay on the page", async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await page.locator('#settings-proxy-host').fill('10.0.0.5');
    await page.locator('[data-action="settings-replace"][data-service="kinopoisk"]').click();
    await page.locator('#settings-token-kinopoisk').fill('1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f');
    await saveCard(page, 'services').click();

    await expect(page.locator('.toast-success')).toHaveText(/Token saved\./);
    expect(panel.lastSettingsSave).toEqual({ tokens: { kinopoisk: '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f' } });
    await expect(foot(page, 'services')).toBeHidden();
    await expect(page.locator('#settings-masked-kinopoisk')).toHaveText('new0*****cafe');
    await expect(page.locator('#settings-proxy-host')).toHaveValue('10.0.0.5');
    await expect(footText(page, 'proxy')).toHaveText('2 unsaved changes');
});

test('the update interval has no Save: picked is saved, then it waits for a restart', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await openSettingsTab(page, 'bot');
    await expect(page.locator('[data-action="settings-save"][data-card="interval"]')).toHaveCount(0);
    await pick(page, 'settings-interval', '6 hours');
    await expect(page.locator('.toast-success')).toHaveText(/Update interval saved\. Restart the bot to apply it\./);
    expect(panel.lastSettingsSave).toEqual({ intervalHours: 6 });
    await expect(page.locator('#settings-restart-text')).toHaveText('Waiting for a restart: the update interval.');
    await expect(page.locator('#settings-interval')).toHaveAttribute('data-dirty', 'false');
});

test('an interval picked again while the last pick is saving is not lost: it is sent next', async ({ page }) => {
    let release;
    const slow = new Promise((resolve) => {
        release = resolve;
    });
    const sent = [];
    const panel = await mockPanel(page);
    await page.route('**/api/settings', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        sent.push(route.request().postDataJSON());
        if (sent.length === 1) await slow;
        return route.fallback();
    });
    await openSettings(page);
    await openSettingsTab(page, 'bot');
    await pick(page, 'settings-interval', '6 hours');
    await expect.poll(() => sent.length).toBe(1);
    await pick(page, 'settings-interval', '12 hours');
    release();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toEqual({ intervalHours: 12 });
    await expect(page.locator('#settings-interval')).toHaveValue('12');
    await expect.poll(() => panel.settings.interval.hours).toBe(12);
});

test('an interval the server refuses goes back to the saved one, with the reason', async ({ page }) => {
    await mockPanel(page, {
        settingsSave: () => ({
            status: 400,
            body: {
                error: 'Nothing was saved: fix the marked fields',
                fields: { interval: 'Pick one of the listed intervals' }
            }
        })
    });
    await openSettings(page);
    await openSettingsTab(page, 'bot');
    await pick(page, 'settings-interval', '6 hours');
    await expect(page.locator('#settings-error-interval')).toHaveText('Pick one of the listed intervals');
    await expect(page.locator('#settings-interval')).toHaveValue('3');
});

test('the restart hint comes only with what this save left waiting', async ({ page }) => {
    // An older change waits already: a TMDB key doesn't need the restart, so it says nothing of it
    await mockPanel(page, { settings: { restart: { pending: ['interval'], blocked: null } } });
    await openSettings(page);
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await page.locator('#settings-token-tmdb').fill('eyJabc.def.ghi');
    await saveCard(page, 'services').click();
    await expect(page.locator('.toast-success')).toHaveText('Token saved.');

    // A Telegram token does
    await page.locator('[data-action="settings-replace"][data-service="telegram"]').click();
    await page.locator('#settings-token-telegram').fill('123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345678');
    await page.locator('[data-action="settings-replace"][data-service="kinopoisk"]').click();
    await page.locator('#settings-token-kinopoisk').fill('1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f');
    // Enter in a token field saves its card: both tokens, nothing else
    await page.locator('#settings-token-kinopoisk').press('Enter');
    await expect(page.locator('.toast-success').last()).toHaveText(/^Tokens saved\. Restart the bot to apply it\./);
});

test('an interval being saved is not an unsaved change: leaving asks nothing', async ({ page }) => {
    let release;
    const slow = new Promise((resolve) => {
        release = resolve;
    });
    await mockPanel(page);
    await page.route('**/api/settings', async (route) => {
        if (route.request().method() === 'POST') await slow;
        return route.fallback();
    });
    await openSettings(page);
    await openSettingsTab(page, 'bot');
    await pick(page, 'settings-interval', '6 hours');
    // The field shows the wait
    await expect(page.locator('#settings-interval')).toHaveAttribute('aria-busy', 'true');
    await openSection(page, 'dashboard');
    await expect(page.locator('#confirm-modal')).toBeHidden();
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    release();
});

test('an interval picked back to the saved one while the first pick saves: the server ends on it', async ({
    page
}) => {
    let release;
    const slow = new Promise((resolve) => {
        release = resolve;
    });
    const sent = [];
    const panel = await mockPanel(page);
    await page.route('**/api/settings', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        sent.push(route.request().postDataJSON());
        if (sent.length === 1) await slow;
        return route.fallback();
    });
    await openSettings(page);
    await openSettingsTab(page, 'bot');
    await pick(page, 'settings-interval', '6 hours');
    await expect.poll(() => sent.length).toBe(1);
    await pick(page, 'settings-interval', '3 hours');
    release();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toEqual({ intervalHours: 3 });
    await expect.poll(() => panel.settings.interval.hours).toBe(3);
    await expect(page.locator('#settings-interval')).toHaveValue('3');
});

test('a tab kept from before that no longer exists opens Connections', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('settings-tab', 'danger-zone'));
    await mockPanel(page);
    await openSettings(page);
    await expect(page.locator('#settings-pane-connections')).toBeVisible();
});

test('tabs: Connections first; the one picked shows its cards and is kept for the next visit', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await expect(page.locator('#settings-pane-connections')).toBeVisible();
    await expect(page.locator('#settings-pane-bot')).toBeHidden();
    await expect(page.locator('#settings-pane-alerts')).toBeHidden();
    await openSettingsTab(page, 'bot');
    await expect(page.locator('#settings-pane-bot')).toBeVisible();
    await expect(page.locator('#settings-pane-connections')).toBeHidden();
    await expect(page.locator('[data-action="settings-tab"][data-tab="bot"]')).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await openSettings(page);
    await expect(page.locator('#settings-pane-bot')).toBeVisible();
});

test('a tab left with unsaved changes in it is marked', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    const connections = page.locator('[data-action="settings-tab"][data-tab="connections"]');
    await expect(connections).toHaveAttribute('data-dirty', 'false');
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await page.locator('#settings-token-tmdb').fill('eyJabc.def.ghi');
    await openSettingsTab(page, 'bot');
    await expect(connections).toHaveAttribute('data-dirty', 'true');
    await expect(connections).toHaveAccessibleDescription('Unsaved changes');
    await openSettingsTab(page, 'connections');
    await foot(page, 'services').locator('[data-action="settings-discard"]').click();
    await expect(connections).toHaveAttribute('data-dirty', 'false');
    await expect(connections).toHaveAccessibleDescription('');
});

test('a token opens with the pencil and closes with the cross, both named for a screen reader', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    const tmdb = page.locator('[data-action="settings-replace"][data-service="tmdb"]');
    await expect(tmdb).toHaveAttribute('aria-label', 'Replace');
    await expect(page.locator('[data-action="settings-replace"][data-service="kinopoisk"]')).toHaveAttribute(
        'aria-label',
        'Set'
    );
    await expect(tmdb).toHaveAttribute('aria-expanded', 'false');
    await tmdb.click();
    await expect(page.locator('#settings-token-tmdb')).toBeFocused();
    await expect(tmdb).toHaveAttribute('aria-label', 'Cancel');
    await expect(tmdb).toHaveAttribute('aria-expanded', 'true');
    // One icon at a time: the cross now
    await expect(tmdb.locator('.icon-close')).toBeVisible();
    await expect(tmdb.locator('.icon-open')).toBeHidden();
    await tmdb.click();
    await expect(page.locator('#settings-token-tmdb')).toBeHidden();
    await expect(tmdb).toHaveAttribute('aria-label', 'Replace');
    // Square, as tall as the field next to it
    const box = await tmdb.boundingBox();
    expect(Math.round(box.width)).toBe(Math.round(box.height));
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
    await saveCard(page, 'services').click();

    await expect(page.locator('#settings-error-tmdb')).toHaveText('TMDB API rejected it: 401 Unauthorized');
    await expect(page.locator('#settings-token-tmdb')).toHaveValue('eyJabc.def.ghi');
    await expect(footText(page, 'services')).toHaveText('1 unsaved change');
});

test('a proxy without a host and a port is not sent', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await expect(page.locator('#settings-proxy-fields')).toBeVisible();
    await page.locator('#settings-proxy-host').fill('10.0.0.5');
    await saveCard(page, 'proxy').click();
    await expect(page.locator('#settings-error-proxy')).toHaveText(
        'Fill in the host and the port, or set the mode to Off'
    );
    expect(panel.lastSettingsSave).toBeUndefined();

    await page.locator('#settings-proxy-port').fill('1080');
    // Enter in a field saves its card
    await page.locator('#settings-proxy-port').press('Enter');
    await expect(page.locator('.toast-success')).toHaveText(/Proxy saved\./);
    expect(panel.lastSettingsSave).toEqual({ proxyUrl: 'socks5h://10.0.0.5:1080' });
});

test('leaving with unsaved changes asks first: Stay keeps them, Discard leaves', async ({ page }) => {
    await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await page.locator('#settings-token-tmdb').fill('eyJabc.def.ghi');

    const leave = async () => {
        await openSection(page, 'dashboard');
    };
    await leave();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#modal-cancel-btn').click();
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    await expect(page.locator('#settings-token-tmdb')).toHaveValue('eyJabc.def.ghi');

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
    await openSettingsTab(page, 'bot');
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
    await openSettingsTab(page, 'bot');
    await page.locator('[data-action="settings-restart"]').click();
    await expect(page.locator('.toast-warning')).toContainText(/Restart in \d+ s\./);
});

test('restart: asks, then waits for the bot to answer again', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await openSettingsTab(page, 'bot');
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
    await expect(foot(page, 'proxy')).toBeHidden();
});

test('a refresh does not close a token field opened for pasting', async ({ page }) => {
    const panel = await mockPanel(page);
    await openSettings(page);
    await page.locator('[data-action="settings-replace"][data-service="tmdb"]').click();
    await expect(page.locator('#settings-token-tmdb')).toBeVisible();
    // The server's restart state changes meanwhile; the open field stays, the new state shows
    panel.settings.restart.pending = ['interval'];
    await openSection(page, 'settings');
    await expect(page.locator('#settings-restart-text')).toContainText('the update interval');
    await expect(page.locator('#settings-token-tmdb')).toBeVisible();
});

test('each tab: two columns that end on one line', async ({ page }) => {
    test.skip((page.viewportSize() || { width: 1280 }).width < 1024, 'one column on a phone');
    await mockPanel(page);
    await openSettings(page);
    const columns = async (pane) =>
        page.locator(`#settings-pane-${pane} > .settings-col`).evaluateAll((cols) =>
            cols.map((col) => ({
                titles: [...col.querySelectorAll('.settings-title')].map((t) => t.firstChild.textContent.trim()),
                bottom: Math.round(col.lastElementChild.getBoundingClientRect().bottom)
            }))
        );
    const [left, right] = await columns('connections');
    expect(left.titles).toEqual(['Services']);
    expect(right.titles).toEqual(['Proxy']);
    expect(left.bottom).toBe(right.bottom);
    // A proxy turned on makes the left column taller: the right one follows
    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await expect(page.locator('#settings-proxy-fields')).toBeVisible();
    const [left2, right2] = await columns('connections');
    expect(left2.bottom).toBe(right2.bottom);

    await openSettingsTab(page, 'bot');
    const [left3, right3] = await columns('bot');
    expect(left3.titles).toEqual(['Panel access', 'Update check', 'Chat change log', 'Year recap by date']);
    expect(right3.titles).toEqual(['Database', 'Bot']);
    expect(left3.bottom).toBe(right3.bottom);
});

test('Restart sits under its description', async ({ page }) => {
    test.skip((page.viewportSize() || { width: 1280 }).width < 1024, 'one column on a phone');
    await mockPanel(page);
    await openSettings(page);
    await openSettingsTab(page, 'bot');
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
    await openSection(page, 'settings');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-check="telegram"]')).toHaveText('✓ 180 ms');

    await pick(page, 'settings-proxy-scheme', 'SOCKS5h');
    await page.locator('#settings-proxy-host').fill('10.0.0.5');
    await page.locator('#settings-proxy-port').fill('1080');
    await page.locator('[data-action="settings-proxy-test"]').click();
    await expect(page.locator('#settings-checks-when')).toContainText('Through the proxy');
    await foot(page, 'proxy').locator('[data-action="settings-discard"]').click();
    await expect(page.locator('#settings-checks-when')).toHaveText('Press Test to check');
});

test('while the settings load, nothing shows that would then jump away', async ({ page }) => {
    let release;
    const hold = new Promise((resolve) => {
        release = resolve;
    });
    await mockPanel(page, { hold });
    await openSection(page, 'settings');
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    await openSettingsTab(page, 'bot');
    const before = await page.locator('#settings-restart-text').boundingBox();
    await openSettingsTab(page, 'connections');
    // The answer is held: the proxy fields stay hidden, as they will be with no proxy saved
    await expect(page.locator('#settings-proxy-fields')).toBeHidden();
    release();
    await expect(page.locator('#settings-masked-telegram')).toHaveText('8123*****xYz4');
    await expect(page.locator('#settings-proxy-fields')).toBeHidden();
    await openSettingsTab(page, 'bot');
    expect((await page.locator('#settings-restart-text').boundingBox()).height).toBe(before.height);
});
