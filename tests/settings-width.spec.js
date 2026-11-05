const { test, expect } = require('@playwright/test');
const { watchConsole, openProfilePage } = require('./helpers');
const { mockPanel } = require('./mock-panel');

watchConsole();

for (const section of ['my-settings', 'my-account']) {
    test(`${section} fills the same content column as Following`, async ({ page }) => {
        await mockPanel(page, { role: 'user', path: '/#my-subs' });
        await expect(page.locator('#my-subs-section')).toBeVisible();
        const following = await page.locator('#my-subs-section').boundingBox();
        await openProfilePage(page, section);
        const settings = page.locator(`#${section}-section`);
        await expect(settings).toBeVisible();
        const box = await settings.boundingBox();
        expect(Math.abs(box.x - following.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - following.width)).toBeLessThanOrEqual(1);
        for (const group of await settings.locator('.group-list, .group-card').all()) {
            expect(Math.abs((await group.boundingBox()).width - following.width)).toBeLessThanOrEqual(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
            page.viewportSize().width
        );
    });
}
