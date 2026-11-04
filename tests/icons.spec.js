const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole } = require('./helpers');
const fs = require('fs');
const path = require('path');

watchConsole({ ignore: /status of 401|Sign in to the panel\./ });

test('local icons render without external services, including on sign-in links', async ({ page }) => {
    const external = [];
    await mockPanel(page, { signedOut: true });
    await page.route('**/*', (route) => {
        if (new URL(route.request().url()).hostname !== 'panel.localhost') {
            external.push(route.request().url());
            return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        }
        return route.fallback();
    });
    await page.reload();
    // The absolute sprite URL must also work below /login/<token>.
    await page.evaluate(() => history.replaceState(null, '', '/login/local-icon-check'));
    const key = page.locator('[data-action="login-password"] svg');
    await expect(key).toBeVisible();
    await expect.poll(() => key.evaluate((el) => el.getBBox().width)).toBeGreaterThan(10);

    const sprite = fs.readFileSync(path.join(__dirname, '../admin/vendor/lucide.svg'), 'utf8');
    const names = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]);
    await page.evaluate((names) => {
        const gallery = document.createElement('div');
        gallery.id = 'icon-check';
        gallery.innerHTML = names.map((name) =>
            `<svg class="icon" viewBox="0 0 24 24" data-name="${name}"><use href="/vendor/lucide.svg#${name}" /></svg>`
        ).join('');
        document.querySelector('#login-body').append(gallery);
    }, names);
    await expect.poll(() => page.locator('#icon-check svg').evaluateAll((icons) =>
        icons.filter((icon) => icon.getBBox().width === 0 || icon.getBBox().height === 0)
            .map((icon) => icon.dataset.name)
    )).toEqual([]);
    expect(external.filter((url) => /\.svg(?:[?#]|$)/.test(url))).toEqual([]);
});
