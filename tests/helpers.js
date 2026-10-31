const { test, expect } = require('@playwright/test');

/**
 * What every browser test shares: a clean console, and getting to a section on any screen.
 */

// responsive.css: from 1024 px down, a bottom tab bar replaces the sidebar
const TABBAR_MAX = 1024;
// responsive.css: from 760 px down, tables become cards with their actions behind "⋯"
const PHONE_MAX = 760;

const widthOf = (page) => (page.viewportSize() || { width: 1280 }).width;
/** The tab bar instead of the sidebar. */
const isNarrow = (page) => widthOf(page) <= TABBAR_MAX;
/** Tables as cards. */
const isPhone = (page) => widthOf(page) <= PHONE_MAX;

/**
 * Fails each test of the file that leaves an error in the console or an uncaught exception.
 * @param {{ ignore?: RegExp }} [options] errors the file expects (a refused save is a 4xx the
 *   browser reports itself)
 */
function watchConsole({ ignore } = {}) {
    test.beforeEach(async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        page.__errors = errors;
    });
    test.afterEach(async ({ page }) => {
        const errors = ignore ? page.__errors.filter((e) => !ignore.test(e)) : page.__errors;
        expect(errors, 'console should stay clean').toEqual([]);
    });
}

/** Opens a section from the sidebar, the tab bar, or the More sheet for those without a tab. */
async function openSection(page, section) {
    if (!isNarrow(page)) {
        await page.locator(`.nav-item[data-section="${section}"]`).click();
        return;
    }
    const tab = page.locator(`.tab-item[data-section="${section}"]`);
    if (await tab.count()) {
        await tab.click();
    } else {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator(`#more-modal [data-section="${section}"]`).click();
    }
}

/** Settings → one of its tabs (connections, bot, alerts). */
async function openSettingsTab(page, tab) {
    await page.locator(`[data-action="settings-tab"][data-tab="${tab}"]`).click();
}

/** An account page's chat: its chip at the top, then the chat in the list it opens. */
async function pickChat(page, section, title) {
    await page.locator(`#${section}-section .mine-chat-chip`).click();
    await page.locator('#profile-modal .pick-row', { hasText: title }).click();
    await expect(page.locator('#profile-modal')).toBeHidden();
}

/** Chat settings or Account settings: from the profile menu behind the chat chip */
async function openProfilePage(page, section, from = 'my-subs') {
    await page.locator(`#${from}-section .mine-chat-chip`).click();
    await page.locator(`#profile-modal [data-section="${section}"]`).click();
    await expect(page.locator(`#${section}-section`)).toHaveClass(/active/);
}

module.exports = { isNarrow, isPhone, watchConsole, openSection, openSettingsTab, pickChat, openProfilePage };
