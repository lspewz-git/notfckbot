const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection } = require('./helpers');

watchConsole();

// The catalog search opens only from Following's +; the other tabs' fields filter their own list
for (const section of ['my-subs']) {
    test(`search focuses during the opening tap from ${section}`, async ({ page }) => {
        await mockPanel(page, { role: 'user' });
        await openSection(page, section);
        // Observe the end of the same click, before timers can lose iOS keyboard permission.
        await page.evaluate(() => {
            window.addEventListener('click', (event) => {
                if (!event.target.closest('[data-action="mine-search-open"]')) return;
                window.__searchTapFocus = document.activeElement.id;
            });
        });
        await page.locator(`#${section}-section [data-action="mine-search-open"]`).first().click();
        expect(await page.evaluate(() => window.__searchTapFocus)).toBe('mine-q');
        await expect(page.locator('#mine-q')).toBeFocused();
    });

    test(`Back clears search and returns to ${section}`, async ({ page }) => {
        await mockPanel(page, { role: 'user' });
        await openSection(page, section);
        await page.locator(`#${section}-section [data-action="mine-search-open"]`).first().click();
        const input = page.locator('#mine-q');
        await input.fill('Дюна');
        await expect(page.locator('#mine-results .search-row')).toHaveCount(3);
        // Back is the only way out: no Cancel, the field runs to the bar's edge (canvas, 23.11)
        await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
        const bar = await page.locator('#my-search-section .search-bar').boundingBox();
        const field = await page.locator('#my-search-section .search-field').boundingBox();
        expect(Math.abs(field.x + field.width - (bar.x + bar.width))).toBeLessThanOrEqual(1);
        await page.getByRole('button', { name: 'Back to Following', exact: true }).click();
        await expect(page.locator(`#${section}-section`)).toHaveClass(/active/);
        await expect(input).toHaveValue('');
        await expect(input).not.toBeFocused();
        await page.locator(`#${section}-section [data-action="mine-search-open"]`).first().click();
        await expect(input).toBeFocused();
        await expect(page.locator('#mine-results')).toContainText('Find a series or film');
        await expect(page.locator('#mine-q-clear')).toBeHidden();
    });
}

test('search input has an iOS-safe font size without disabling pinch zoom', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-section [data-action="mine-search-open"]').click();
    expect(
        await page.locator('#mine-q').evaluate((input) => parseFloat(getComputedStyle(input).fontSize))
    ).toBeGreaterThanOrEqual(16);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/);
});

test('Back ignores a search response arriving after reopening', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let arrived;
    const started = new Promise((resolve) => (arrived = resolve));
    await page.route('**/api/account/chats/*/search?*', async (route) => {
        arrived();
        await held;
        await route.fulfill({ json: [{ tmdbId: 'late', title: 'Late result', kind: 'movie' }] });
    });
    await page.locator('#my-subs-section [data-action="mine-search-open"]').click();
    await page.locator('#mine-q').fill('late');
    await page.locator('#mine-q').press('Enter');
    await started;
    await page.getByRole('button', { name: 'Back to Following', exact: true }).click();
    await page.locator('#my-subs-section [data-action="mine-search-open"]').click();
    const answered = page.waitForResponse((response) => response.url().includes('/search?q=late'));
    release();
    await answered;
    await expect(page.locator('#mine-q')).toHaveValue('');
    await expect(page.locator('#mine-results')).toContainText('Find a series or film');
    await expect(page.locator('#mine-results .search-row')).toHaveCount(0);
});
