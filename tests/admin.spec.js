const { test, expect } = require('@playwright/test');

/**
 * Read-only checks against a running panel. Dialogs are opened and dismissed;
 * nothing is created, edited or deleted, so this is safe to point at a live
 * instance. Assertions are about structure and behaviour, not about specific
 * records, since the data is whatever the instance happens to hold.
 */

/** Rows only mean something once the skeleton has been replaced by data. */
async function waitForRows(page, bodyId) {
    await expect(page.locator(`#${bodyId} .skeleton-row`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(`#${bodyId} tr`).first()).toBeVisible();
}

/** Rows are hidden with inline display:none, which older Playwright cannot filter on. */
function visibleRows(page, bodyId) {
    return page.locator(`#${bodyId} tr`).evaluateAll((rows) => rows.filter((r) => r.style.display !== 'none').length);
}

/** The sidebar is a drawer below 1024px, so a section has to be reached differently. */
async function goToSection(page, section) {
    const width = page.viewportSize().width;
    if (width <= 1024) await page.locator('#nav-toggle').click();
    await page.locator(`.nav-item[data-section="${section}"]`).click();
    await expect(page.locator(`#${section}-section`)).toHaveClass(/active/);
}

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('/');
    await expect(page.locator('#chats-count')).not.toHaveText('-');
    page.__errors = errors;
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'console should stay clean').toEqual([]);
});

test('dashboard renders counters, health and popularity', async ({ page }) => {
    await expect(page.locator('#chats-count')).toHaveText(/^\d+$/);
    await expect(page.locator('#subs-count')).toHaveText(/^\d+$/);
    await expect(page.locator('#health-tg')).toHaveText(/TG: (OK|ERR)/);
    await expect(page.locator('#popular-list .popular-item').first()).toBeVisible();
});

test('every module loads', async ({ page }) => {
    const loaded = await page.evaluate(
        () => performance.getEntriesByType('resource').filter((r) => r.name.includes('/js/')).length
    );
    expect(loaded).toBeGreaterThanOrEqual(16);
});

test('a table shows skeleton rows before its data arrives', async ({ page }) => {
    const width = page.viewportSize().width;
    if (width <= 1024) await page.locator('#nav-toggle').click();

    // The skeleton is painted in the same tick as the click
    await page.locator('.nav-item[data-section="chats"]').click();
    expect(await page.locator('#chats-body .skeleton-row').count()).toBeGreaterThan(0);

    await expect(page.locator('#chats-body .skeleton-row')).toHaveCount(0, { timeout: 10_000 });
    expect(await page.locator('#chats-body tr').count()).toBeGreaterThan(0);
});

test('chat rows expose one action menu that opens and closes', async ({ page }) => {
    await goToSection(page, 'chats');
    await waitForRows(page, 'chats-body');
    await page.locator('#chats-body [data-action="chat-actions"]').first().click();

    const modal = page.locator('#chat-actions-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#chat-actions-title')).not.toBeEmpty();

    await modal.locator('[data-close="chat-actions-modal"]').click();
    await expect(modal).toBeHidden();
});

test('subscriptions show a status and let the mode be reviewed', async ({ page }) => {
    await goToSection(page, 'subs');
    await waitForRows(page, 'subs-body');

    const status = page.locator('#subs-body [data-label="Status"]').first();
    await expect(status).toHaveText(/On Air|Ended|Canceled|In Production|Planned|Pilot|Unknown/);

    await page.locator('#subs-body [data-action="mode"]').first().click();
    const modal = page.locator('#mode-modal');
    await expect(modal).toBeVisible();
    // The custom trigger must mirror the hidden <select>
    await expect(modal.locator('.custom-select-trigger')).not.toBeEmpty();

    await modal.locator('[data-close="mode-modal"]').click();
    await expect(modal).toBeHidden();
});

test('declining the confirmation leaves the data alone', async ({ page }) => {
    await goToSection(page, 'subs');
    await waitForRows(page, 'subs-body');
    const before = await page.locator('#subs-body tr').count();

    await page.locator('#subs-body [data-action="delete-sub"]').first().click();
    const confirm = page.locator('#confirm-modal');
    await expect(confirm).toBeVisible();

    // Safe choice is the emphasised one and holds focus
    await expect(page.locator('#modal-cancel-btn')).toBeFocused();
    await page.locator('#modal-cancel-btn').click();

    await expect(confirm).toBeHidden();
    await expect(page.locator('#subs-body tr')).toHaveCount(before);
});

test('the search box filters rows and restores them', async ({ page }) => {
    await goToSection(page, 'watchlist');
    await waitForRows(page, 'watchlist-body');
    const total = await page.locator('#watchlist-body tr').count();
    expect(total).toBeGreaterThan(0);

    await page.locator('#watchlist-filter').fill('zzz-no-such-record');
    await expect.poll(() => visibleRows(page, 'watchlist-body')).toBe(0);

    await page.locator('#watchlist-filter').fill('');
    await expect.poll(() => visibleRows(page, 'watchlist-body')).toBe(total);
});

test('log filters switch the visible entries', async ({ page }) => {
    await goToSection(page, 'logs');
    await expect(page.locator('#logs-viewer .log-entry').first()).toBeVisible();

    await page.locator('[data-log-filter="error"]').click();
    await expect(page.locator('[data-log-filter="error"]')).toHaveClass(/active/);

    await page.locator('[data-log-filter="all"]').click();
    await expect(page.locator('[data-log-filter="all"]')).toHaveClass(/active/);
    expect(await page.locator('#logs-viewer .log-entry').count()).toBeGreaterThan(0);
});

test('the proxy dialog composes a URL and hides the password', async ({ page }) => {
    await page.locator('[data-action="proxy"]').click();
    const modal = page.locator('#proxy-modal');
    await expect(modal).toBeVisible();

    // Pick SOCKS5h through the styled dropdown, as a user would
    await modal.locator('.custom-select-trigger').click();
    await page.locator('.custom-select-panel .custom-select-option', { hasText: 'SOCKS5h' }).click();
    await expect(page.locator('#proxy-fields')).toBeVisible();

    await page.locator('#proxy-host').fill('10.0.0.5');
    await page.locator('#proxy-port').fill('1080');
    await expect(page.locator('#proxy-preview')).toHaveText('socks5h://10.0.0.5:1080');

    await page.locator('#proxy-user').fill('bob');
    await page.locator('#proxy-pass').fill('sekret');
    await expect(page.locator('#proxy-preview')).toHaveText('socks5h://bob:•••@10.0.0.5:1080');
    await expect(page.locator('#proxy-preview')).not.toContainText('sekret');

    // Leave without saving
    await modal.locator('[data-close="proxy-modal"]').click();
    await expect(modal).toBeHidden();
});

test('dialogs are announced, trap focus and close on Escape', async ({ page }) => {
    await goToSection(page, 'chats');
    await waitForRows(page, 'chats-body');
    const opener = page.locator('#chats-body [data-action="chat-actions"]').first();
    await opener.click();

    const modal = page.locator('#chat-actions-modal');
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');

    const labelledBy = await modal.getAttribute('aria-labelledby');
    await expect(page.locator(`#${labelledBy}`)).toBeVisible();

    // Focus must land inside the dialog, not stay behind it
    await expect(modal.locator(':focus')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
});

test('sections are reachable with the keyboard alone', async ({ page }) => {
    const width = page.viewportSize().width;
    if (width <= 1024) await page.locator('#nav-toggle').click();

    const item = page.locator('.nav-item[data-section="subs"]');
    await expect(item).toHaveAttribute('role', 'button');
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#subs-section')).toHaveClass(/active/);
});

test.describe('narrow screens', () => {
    // viewport is a real fixture; project name is not
    test.skip(({ viewport }) => viewport.width > 640, 'narrow viewports only');

    test('the sidebar is a drawer and tables become cards', async ({ page }) => {
        const sidebar = page.locator('.sidebar');
        await expect(page.locator('#nav-toggle')).toBeVisible();

        await page.locator('#nav-toggle').click();
        await expect(sidebar).toHaveClass(/open/);

        // The buttons pinned to the bottom must be reachable, not under the browser chrome
        await expect(page.locator('#danger-btn')).toBeInViewport();

        await page.locator('.nav-item[data-section="chats"]').click();
        await expect(sidebar).not.toHaveClass(/open/);
        await waitForRows(page, 'chats-body');

        const cell = page.locator('#chats-body td').first();
        await expect(cell).toHaveCSS('display', 'flex');
        const label = await cell.evaluate((el) => getComputedStyle(el, '::before').content);
        expect(label).toContain('Chat ID');

        const overflows = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
        expect(overflows, 'page must not scroll sideways').toBe(false);
    });
});
