const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/** The proxy dialog's Test button: Telegram, TMDB and a neutral site, each reported. */

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.__errors = errors;
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'console should stay clean').toEqual([]);
});

/** Opens the dialog and fills in a SOCKS5h proxy, then presses Test. */
async function testProxy(page) {
    await page.locator('[data-action="proxy"]').first().click();
    const modal = page.locator('#proxy-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.custom-select-trigger').click();
    await page.locator('.custom-select-panel .custom-select-option', { hasText: 'SOCKS5h' }).click();
    await page.locator('#proxy-host').fill('10.0.0.5');
    await page.locator('#proxy-port').fill('1080');
    await page.locator('#proxy-test').click();
}

const check = (ok, ms, extra = {}) => ({ ok, ms, ...extra });

test('all three reached: one line per target, with the IP the proxy goes out from', async ({ page }) => {
    await mockPanel(page);
    await testProxy(page);
    await expect(page.locator('.toast-success')).toHaveText(
        'Proxy: Telegram ✓ 180 ms · TMDB ✓ 240 ms · Internet ✓ 95 ms (IP 203.0.113.7)'
    );
});

test('TMDB down while the proxy works: a warning that names TMDB', async ({ page }) => {
    await mockPanel(page, {
        proxyTest: {
            success: true,
            direct: false,
            proxyDown: null,
            checks: {
                telegram: check(true, 180),
                tmdb: check(false, 300, { error: 'replied 503' }),
                internet: check(true, 95, { ip: '203.0.113.7' })
            }
        }
    });
    await testProxy(page);
    await expect(page.locator('.toast-warning')).toContainText('TMDB ✗ replied 503');
    await expect(page.locator('.toast-warning')).toContainText('Telegram ✓');
});

test('nothing got through: the proxy itself is named, not the services', async ({ page }) => {
    const down = check(false, 5, { error: 'ECONNREFUSED' });
    await mockPanel(page, {
        proxyTest: {
            success: false,
            direct: false,
            proxyDown: 'ECONNREFUSED',
            checks: { telegram: down, tmdb: down, internet: down }
        }
    });
    await testProxy(page);
    await expect(page.locator('.toast-error')).toHaveText('Proxy unreachable: ECONNREFUSED');
});
