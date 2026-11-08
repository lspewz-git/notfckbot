const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection } = require('./helpers');

watchConsole();

for (const section of ['my-calendar', 'my-aired', 'my-subs']) {
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

    test(`Cancel clears search and returns to ${section}`, async ({ page }) => {
        await mockPanel(page, { role: 'user' });
        await openSection(page, section);
        await page.locator(`#${section}-section [data-action="mine-search-open"]`).first().click();
        const input = page.locator('#mine-q');
        await input.fill('Дюна');
        await expect(page.locator('#mine-results .search-row')).toHaveCount(3);
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        const [fieldBox, cancelBox] = await Promise.all([input.boundingBox(), cancel.boundingBox()]);
        expect(cancelBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width);
        expect(cancelBox.height).toBeGreaterThanOrEqual(44);
        expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(page.viewportSize().width);
        await cancel.click();
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
    await openSection(page, 'my-calendar');
    await page.locator('#my-calendar-section [data-action="mine-search-open"]').click();
    expect(
        await page.locator('#mine-q').evaluate((input) => parseFloat(getComputedStyle(input).fontSize))
    ).toBeGreaterThanOrEqual(16);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/);
});

test('Cancel ignores a search response arriving after reopening', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-calendar');
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let arrived;
    const started = new Promise((resolve) => (arrived = resolve));
    await page.route('**/api/account/chats/*/search?*', async (route) => {
        arrived();
        await held;
        await route.fulfill({ json: [{ tmdbId: 'late', title: 'Late result', kind: 'movie' }] });
    });
    await page.locator('#my-calendar-section .search-pill').click();
    await page.locator('#mine-q').fill('late');
    await page.locator('#mine-q').press('Enter');
    await started;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('#my-calendar-section .search-pill').click();
    const answered = page.waitForResponse((response) => response.url().includes('/search?q=late'));
    release();
    await answered;
    await expect(page.locator('#mine-q')).toHaveValue('');
    await expect(page.locator('#mine-results')).toContainText('Find a series or film');
    await expect(page.locator('#mine-results .search-row')).toHaveCount(0);
});
