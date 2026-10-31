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

test('the open section is kept in the address: a reload opens it again', async ({ page }) => {
    await mockPanel(page);
    await openSection(page, 'chats');
    await expect(page).toHaveURL(/#chats$/);

    await page.reload();
    await expect(page.locator('#chats-section')).toBeVisible();
    await expect(page.locator('#dashboard-section')).toBeHidden();
});

test("a user's address naming an admin section opens their subscriptions instead", async ({ page }) => {
    await mockPanel(page, { role: 'user', path: '/#logs' });
    await expect(page.locator('#my-subs-section')).toBeVisible();
    await expect(page.locator('#logs-section')).toBeHidden();
    await expect(page).toHaveURL(/#my-subs$/);
});

/** A finger pulling the page down by `dy` px from near the top, as touch events. */
async function pullDown(page, dy) {
    await page.evaluate(async (dy) => {
        const target = document.elementFromPoint(innerWidth / 2, 200);
        const fire = (type, y) => {
            const e = new Event(type, { bubbles: true });
            const touches = type === 'touchend' ? [] : [{ clientX: innerWidth / 2, clientY: y }];
            Object.defineProperty(e, 'touches', { value: touches });
            target.dispatchEvent(e);
        };
        fire('touchstart', 200);
        for (let y = 200; y <= 200 + dy; y += 20) {
            fire('touchmove', y);
            await new Promise((r) => requestAnimationFrame(r));
        }
        fire('touchend', 200 + dy);
    }, dy);
}

/** Checks right away (not retrying) that the pull did nothing, then that nothing was asked for. */
async function expectNoRefresh(page, asked) {
    expect(await page.evaluate(() => document.getElementById('pull-refresh').className)).toBe('pull-refresh');
    // Longer than the shortest refresh (MIN_SPIN_MS), so a request it started would be seen
    await page.waitForTimeout(700);
    expect(asked).toEqual([]);
}

test('pulling the page down refreshes the open section without reloading the page', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch screens');
    await mockPanel(page);
    await openSection(page, 'chats');
    await expect(page.locator('#chats-section')).toBeVisible();
    await page.evaluate(() => (window.__samePage = true));

    const asked = [];
    page.on('request', (r) => r.url().includes('/api/') && asked.push(new URL(r.url()).pathname));

    // A short pull springs back and asks for nothing
    await pullDown(page, 60);
    await expectNoRefresh(page, asked);

    await pullDown(page, 200);
    await expect(page.locator('#pull-refresh')).toHaveClass(/refreshing/);
    // Meanwhile the page waits moved down, the ring in the gap above it
    const pageShift = () =>
        page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.main-inner')).transform).m42);
    await expect.poll(pageShift).toBeCloseTo(56, 0);
    await expect.poll(() => asked.some((p) => p.includes('chats'))).toBe(true);
    // Done: a check for a moment, then the page slides back, and the page and tab are the same
    await expect(page.locator('#pull-refresh')).toHaveClass(/done/);
    await expect(page.locator('#pull-refresh')).toHaveClass('pull-refresh');
    await expect(page.locator('html')).not.toHaveClass(/pull-moving/);
    expect(await pageShift()).toBe(0);
    expect(await page.evaluate(() => window.__samePage)).toBe(true);
    await expect(page.locator('#chats-section')).toBeVisible();
    await expect(page).toHaveURL(/#chats$/);
});

test('no pull to refresh while a dialog is open or the page is scrolled down', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch screens');
    await mockPanel(page);
    // The dashboard: tall enough to scroll
    await expect(page.locator('#popular-list [data-action="series"]').first()).toBeVisible();

    const asked = [];
    page.on('request', (r) => r.url().includes('/api/') && asked.push(r.url()));

    await page.evaluate(() => window.scrollTo(0, 300));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await pullDown(page, 200);
    await expectNoRefresh(page, asked);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.tab-item[data-open="more-modal"]').click();
    await expect(page.locator('#more-modal')).toBeVisible();
    await pullDown(page, 200);
    await expectNoRefresh(page, asked);
});

test('on a wide screen the rail and content sit centered, every rail label fits', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop layout');
    await page.setViewportSize({ width: 1920, height: 900 });
    await mockPanel(page);
    await expect(page.locator('#popular-list [data-action="series"]').first()).toBeVisible();

    const box = await page.locator('.app-container').boundingBox();
    expect(box.width).toBe(1320);
    const viewport = await page.evaluate(() => document.body.clientWidth); // less the scrollbar
    expect(Math.abs(box.x - (viewport - box.width) / 2)).toBeLessThanOrEqual(1);

    // Labels are whole, not cut with an ellipsis, and the last rail item is on screen
    const cut = await page.$$eval('.sidebar .nav-label', (els) =>
        els.filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth).map((e) => e.textContent),
    );
    expect(cut).toEqual([]);
    const last = await page.locator('.rail-bottom .nav-item:visible').last().boundingBox();
    expect(last.y + last.height).toBeLessThanOrEqual(900);
});
