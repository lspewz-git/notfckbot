const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole } = require('./helpers');
const fs = require('fs');
const path = require('path');

watchConsole({ ignore: /status of 401|Sign in to the panel\./ });

test('local icons render without external services, including on sign-in links', async ({ page }) => {
    const external = [];
    const sprites = [];
    page.on('request', (request) => {
        if (request.url().includes('lucide')) sprites.push(request.url());
    });
    await mockPanel(page, { signedOut: true });
    await page.route('**/*', (route) => {
        if (new URL(route.request().url()).hostname !== 'panel.localhost') {
            external.push(route.request().url());
            return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        }
        return route.fallback();
    });
    await page.reload();
    // The icons live in the page, so they also draw below /login/<token>
    await page.evaluate(() => history.replaceState(null, '', '/login/local-icon-check'));
    const key = page.locator('[data-action="login-password"] svg');
    await expect(key).toBeVisible();
    await expect.poll(() => key.evaluate((el) => el.getBBox().width)).toBeGreaterThan(10);

    const html = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
    const names = [...html.matchAll(/<symbol id="(i-[^"]+)"/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(50);
    // Every icon the panel asks for exists in the page
    const used = new Set();
    for (const dir of ['../admin/js', '../admin']) {
        for (const file of fs.readdirSync(path.join(__dirname, dir)).filter((f) => /\.(js|html)$/.test(f))) {
            const text = fs.readFileSync(path.join(__dirname, dir, file), 'utf8');
            for (const match of text.matchAll(/href="#(i-[a-z0-9-]+)"/g)) used.add(match[1]);
        }
    }
    expect([...used].filter((name) => !names.includes(name))).toEqual([]);
    await page.evaluate((names) => {
        const gallery = document.createElement('div');
        gallery.id = 'icon-check';
        gallery.innerHTML = names
            .map((name) => `<svg class="icon" viewBox="0 0 24 24" data-name="${name}"><use href="#${name}" /></svg>`)
            .join('');
        document.querySelector('#login-body').append(gallery);
    }, names);
    await expect
        .poll(() =>
            page
                .locator('#icon-check svg')
                .evaluateAll((icons) =>
                    icons
                        .filter((icon) => icon.getBBox().width === 0 || icon.getBBox().height === 0)
                        .map((icon) => icon.dataset.name)
                )
        )
        .toEqual([]);
    expect(external.filter((url) => /\.svg(?:[?#]|$)/.test(url))).toEqual([]);
    // Nothing asks for a sprite file: each request would delay the icons in WebKit
    expect(sprites).toEqual([]);
});
