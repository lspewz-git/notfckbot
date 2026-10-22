const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * Moving between the panel's sections, on the canned API: each one opens at its top, whatever
 * the previous one was scrolled to.
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

const go = (page, section) => {
    const narrow = page.viewportSize().width < 1024;
    if (narrow && ['history', 'logs', 'settings', 'maintenance'].includes(section)) {
        return page
            .locator('.tab-item[data-open="more-modal"]')
            .click()
            .then(() => page.locator(`#more-modal [data-section="${section}"]`).click());
    }
    return page.locator(`${narrow ? '.tab-item' : '.nav-item'}[data-section="${section}"]`).click();
};

test('a section opens at its top, not where the previous one was scrolled to', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#popular-list [data-action="series"]').first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await go(page, 'subs');
    await expect(page.locator('#subs-section')).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // And back again, after scrolling this one down
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await go(page, 'dashboard');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
