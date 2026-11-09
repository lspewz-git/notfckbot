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
    if (['my-calendar', 'my-aired', 'my-subs'].includes(section) && !(await page.locator('body').evaluate((el) => el.classList.contains('view-mine')))) {
        if (!(await page.locator('#my-profile-section').isVisible())) await openAccount(page);
        await page.locator('#my-profile-body .chat-row[aria-pressed="true"]').click();
    }
    if (section === 'recap') {
        await openSection(page, 'tools');
        await page.locator('#tools-section [data-section="recap"]').click();
        return;
    }
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
        // Keyboard focus can move to the section only after its outgoing sheet leaves the top layer.
        await expect(page.locator('#more-modal')).toBeHidden();
    }
}

/** Settings → one of its tabs (connections, bot, alerts). */
async function openSettingsTab(page, tab) {
    await page.locator(`[data-action="settings-tab"][data-tab="${tab}"]`).click();
}

/** An account page's chat: its chip at the top, then the chat in the list it opens. */
/** The chat chip at the top of a personal tab links to Account. */
const profileButton = (page, section) => page.locator(`#${section}-section [data-chat-picker] [data-section="my-profile"]`);

async function pickChat(page, section, title) {
    const header = profileButton(page, section);
    if (await header.count()) await header.click();
    else await openAccount(page);
    await page.locator('#my-profile-body [data-action="profile-chat"]', { hasText: title }).click();
    if (section === 'my-settings') await openProfilePage(page, section);
    else await openSection(page, section);
}

/** The Account tab: the tab bar's Account, the rail's, or an admin header's chip */
async function openAccount(page) {
    const active = (await page.locator('.section.active').getAttribute('id')) || '';
    const adminChip = page.locator(`#${active} [data-admin-profile] a`);
    if (await adminChip.count()) await adminChip.click();
    else if (isNarrow(page)) await page.locator('.tab-profile').click();
    else await page.locator('.nav-item[data-section="my-profile"]').click();
    await expect(page.locator('#my-profile-section')).toHaveClass(/active/);
}

/** Chat settings or Account settings: rows on the Account tab */
async function openProfilePage(page, section) {
    if (!(await page.locator('#my-profile-section').evaluate((el) => el.classList.contains('active'))))
        await openAccount(page);
    if (section === 'my-profile') return;
    await page.locator(`#my-profile-body [data-section="${section}"]`).last().click();
    await expect(page.locator(`#${section}-section`)).toHaveClass(/active/);
}

async function openActions(page) {
    if (isNarrow(page)) {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator('#more-modal [data-open="actions-modal"]').click();
    } else {
        await page.locator('#actions-btn').click();
    }
}

module.exports = {
    isNarrow,
    isPhone,
    watchConsole,
    openSection,
    openSettingsTab,
    pickChat,
    openAccount,
    openProfilePage,
    profileButton,
    openActions
};
