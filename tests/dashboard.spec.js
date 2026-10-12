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
