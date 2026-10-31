const { test, expect } = require('@playwright/test');
const { isNarrow, isPhone, watchConsole, openSection } = require('./helpers');

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

/** Opens a subscription's Mode or Delete, through the phone menu where there is one. */
async function subAction(page, action) {
    if (isPhone(page)) {
        await page.locator('#subs-body [data-action="sub-actions"]').first().click();
        await expect(page.locator('#sub-actions-modal')).toBeVisible();
        await page.locator(action === 'mode' ? '#sub-action-mode' : '#sub-action-delete').click();
    } else {
        await page
            .locator(`#subs-body [data-action="${action === 'mode' ? 'mode' : 'delete-sub'}"]`)
            .first()
            .click();
    }
}

/** Opens a section and waits until it is the one shown. */
async function goToSection(page, section) {
    await openSection(page, section);
    await expect(page.locator(`#${section}-section`)).toHaveClass(/active/);
}

watchConsole();

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#chats-count')).not.toHaveText('-');
});

test('dashboard renders counters, health and popularity', async ({ page }) => {
    await expect(page.locator('#chats-count')).toHaveText(/^\d+$/);
    await expect(page.locator('#subs-count')).toHaveText(/^\d+$/);
    // "TG" when fine, "TG: ERR" when not
    await expect(page.locator('#health-tg')).toHaveText(/^TG(: ERR)?$/);
    await expect(page.locator('#popular-list .popular-item:not(.skeleton-item)').first()).toBeVisible();
});

test('a table shows skeleton rows before its data arrives', async ({ page }) => {
    // The skeleton is painted in the same tick as the click
    await openSection(page, 'chats');
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

    await modal.locator('.modal-x').click();
    await expect(modal).toBeHidden();
});

test('subscriptions show a status and let the mode be reviewed', async ({ page }) => {
    await goToSection(page, 'subs');
    await waitForRows(page, 'subs-body');

    const status = page.locator('#subs-body [data-label="Status"]').first();
    await expect(status).toHaveText(/On Air|Ended|Canceled|In Production|Planned|Pilot|Unknown/);

    await subAction(page, 'mode');
    const modal = page.locator('#mode-modal');
    await expect(modal).toBeVisible();
    // The custom trigger must mirror the hidden <select>
    await expect(modal.locator('.custom-select-trigger')).not.toBeEmpty();

    await modal.locator('[data-close-return="mode-modal"]').click();
    await expect(modal).toBeHidden();
    // Opened from the phone menu, Cancel goes back to it
    if (isPhone(page)) {
        await expect(page.locator('#sub-actions-modal')).toBeVisible();
        await page.keyboard.press('Escape');
    }
});

test('declining the confirmation leaves the data alone', async ({ page }) => {
    await goToSection(page, 'subs');
    await waitForRows(page, 'subs-body');
    const before = await page.locator('#subs-body tr').count();

    await subAction(page, 'delete');
    const confirm = page.locator('#confirm-modal');
    await expect(confirm).toBeVisible();

    // Safe choice is the emphasised one and holds focus; on a touch screen focus stays on the
    // dialog's box, so no focus ring shows on a button nobody pressed
    if (isPhone(page)) {
        expect(await page.evaluate(() => document.activeElement.className)).toContain('modal-content');
    } else {
        await expect(page.locator('#modal-cancel-btn')).toBeFocused();
    }
    await page.locator('#modal-cancel-btn').click();

    await expect(confirm).toBeHidden();
    if (isPhone(page)) await page.keyboard.press('Escape');
    await expect(page.locator('#subs-body tr')).toHaveCount(before);
});

test('the search box filters rows and restores them', async ({ page }) => {
    await goToSection(page, 'watchlist');
    await waitForRows(page, 'watchlist-body');
    // The pager shows one page, so compare what is visible, not every row in the DOM
    const shown = await visibleRows(page, 'watchlist-body');
    expect(shown).toBeGreaterThan(0);

    await page.locator('#watchlist-filter').fill('zzz-no-such-record');
    await expect.poll(() => visibleRows(page, 'watchlist-body')).toBe(0);

    await page.locator('#watchlist-filter').fill('');
    await expect.poll(() => visibleRows(page, 'watchlist-body')).toBe(shown);
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

test('dialogs are announced, modal, and close on Escape', async ({ page }) => {
    await goToSection(page, 'chats');
    await waitForRows(page, 'chats-body');
    const opener = page.locator('#chats-body [data-action="chat-actions"]').first();
    await opener.click();

    const modal = page.locator('#chat-actions-modal');
    // A native <dialog> opened with showModal(): announced as a dialog, the page behind inert
    await expect(modal).toHaveJSProperty('tagName', 'DIALOG');
    expect(await modal.evaluate((d) => d.matches(':modal'))).toBe(true);

    const labelledBy = await modal.getAttribute('aria-labelledby');
    await expect(page.locator(`#${labelledBy}`)).toBeVisible();

    // Focus must land inside the dialog, not stay behind it
    await expect(modal.locator(':focus')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
});

test('sections are reachable with the keyboard alone', async ({ page }) => {
    const item = page.locator(`${isNarrow(page) ? '.tab-item' : '.nav-item'}[data-section="subs"]`);
    // A native <button>, so Enter and Space work without a key handler
    await expect(item).toHaveJSProperty('tagName', 'BUTTON');
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#subs-section')).toHaveClass(/active/);
    await expect(item).toHaveAttribute('aria-current', 'page');
});

test.describe('narrow screens', () => {
    // viewport is a real fixture; project name is not
    test.skip(({ viewport }) => viewport.width > 760, 'phone widths only: tables as cards');

    test('a bottom tab bar replaces the sidebar and tables become cards', async ({ page }) => {
        await expect(page.locator('.sidebar')).toBeHidden();
        const tabbar = page.locator('.tabbar');
        await expect(tabbar).toBeInViewport();

        // Everything that doesn't fit in five tabs is one tap away under "More"
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await expect(page.locator('#more-modal [data-open="about-modal"]')).toBeInViewport();
        // About from the sheet: the sheet gives way, the dialog comes filled in
        await page.locator('#more-modal [data-open="about-modal"]').click();
        await expect(page.locator('#more-modal')).toBeHidden();
        await expect(page.locator('#about-version dt').first()).toHaveText('Version');
        await expect(page.locator('#about-version .skeleton')).toHaveCount(0);
        await page.keyboard.press('Escape');

        await page.locator('.tab-item[data-section="chats"]').click();
        await expect(page.locator('.tab-item[data-section="chats"]')).toHaveAttribute('aria-current', 'page');
        await waitForRows(page, 'chats-body');

        // Compact cards: a two-line summary and an icon button; the per-column cells are hidden
        const row = page.locator('#chats-body tr').first();
        await expect(row.locator('.cell-compact')).toBeVisible();
        await expect(row.locator('td[data-label="Chat ID"]')).toBeHidden();
        await expect(row.locator('[data-action="chat-actions"]')).toBeVisible();
        expect((await row.boundingBox()).height).toBeLessThan(90);

        const overflows = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
        expect(overflows, 'page must not scroll sideways').toBe(false);
    });
});
