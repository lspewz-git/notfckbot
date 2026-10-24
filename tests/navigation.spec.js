const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * Moving between the panel's sections, on the canned API: each one opens at its top, whatever
 * the previous one was scrolled to.
 */

watchConsole();

test('a section opens at its top, not where the previous one was scrolled to', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#popular-list [data-action="series"]').first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await openSection(page, 'subs');
    await expect(page.locator('#subs-section')).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // And back again, after scrolling this one down
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await openSection(page, 'dashboard');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
