const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');

/**
 * The panel's dialogs are native <dialog>s opened with showModal(), on the canned API: on top of
 * everything with the page behind out of reach, toasts and dropdown lists still shown above
 * them, Escape closing the innermost layer first, focus given back on closing.
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

const narrow = (page) => (page.viewportSize() || { width: 1280 }).width < 1024;

async function openChatSettings(page) {
    await page.locator(`${narrow(page) ? '.tab-item' : '.nav-item'}[data-section="chats"]`).click();
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await page.locator('#action-settings').click();
    await expect(page.locator('#chat-settings-modal')).toBeVisible();
}

/**
 * Whether the element is what is drawn on top at its middle, or something covers it. Toasts let
 * clicks through (pointer-events: none), so that is lifted for the check.
 */
const onTop = (locator) =>
    locator.evaluate((el) => {
        const through = el.closest('.toast-container');
        if (through) through.style.pointerEvents = 'auto';
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (through) through.style.pointerEvents = '';
        return Boolean(hit && el.contains(hit));
    });

test('a dialog is modal: the page behind is out of reach', async ({ page }) => {
    await mockPanel(page);
    await page.locator('#popular-list [data-action="series"]').first().click();
    const card = page.locator('#detail-modal');
    await expect(card).toBeVisible();
    expect(await card.evaluate((d) => d.matches(':modal'))).toBe(true);
    // The sidebar or tab bar under the dim does not take the click
    const behind = page.locator(narrow(page) ? '.tab-item[data-section="chats"]' : '.nav-item[data-section="chats"]');
    expect(await onTop(behind)).toBe(false);
});

test('a toast shown while a dialog is open is drawn above it, and stays after it closes', async ({ page }) => {
    await mockPanel(page);
    await page.locator('#popular-list [data-action="series"]').first().click();
    await expect(page.locator('#detail-modal')).toBeVisible();
    await page.evaluate(() => import('./js/ui.js').then((ui) => ui.toast('Saved', 'success', 60000)));
    const toast = page.locator('.toast', { hasText: 'Saved' });
    await expect(toast).toBeVisible();
    expect(await onTop(toast)).toBe(true);

    await page.locator('#detail-modal .modal-x').click();
    await expect(page.locator('#detail-modal')).toBeHidden();
    await expect(toast).toBeVisible();
    expect(await onTop(toast)).toBe(true);
    expect(await page.evaluate(() => document.getElementById('toast-container').parentElement.tagName)).toBe('BODY');
});

test('a dialog closed by the panel itself (a save) takes an open list with it', async ({ page }) => {
    await mockPanel(page);
    await openChatSettings(page);
    await page.locator('.custom-select:has(#chat-settings-timezone) .custom-select-trigger').click();
    await expect(page.locator('.custom-select-panel')).toHaveCount(1);
    await page.evaluate(() => import('./js/ui.js').then((ui) => ui.closeModal('chat-settings-modal')));
    await expect(page.locator('.custom-select-panel')).toHaveCount(0);
    // So the next Escape closes the next dialog at once, not a hidden list
    await page.evaluate(() => import('./js/ui.js').then((ui) => ui.openModal('detail-modal')));
    await page.keyboard.press('Escape');
    await expect(page.locator('#detail-modal')).toBeHidden();
});

test('Tab and Shift+Tab never reach the page behind an open dialog', async ({ page }) => {
    test.skip(narrow(page), 'a keyboard');
    await mockPanel(page);
    await openChatSettings(page);
    for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 15; i++) {
            await page.keyboard.press(key);
            const outside = await page.evaluate(() => {
                const el = document.activeElement;
                return Boolean(el && el !== document.body && !el.closest('dialog[open]'));
            });
            expect(outside, `${key} #${i + 1}`).toBe(false);
        }
    }
});

test('a confirmation lands on its safe choice on a computer, on its box on a touch screen', async ({ page }) => {
    await mockPanel(page);
    if (narrow(page)) {
        await page.locator('.tab-item[data-open="more-modal"]').click();
        await page.locator('#more-modal [data-section="settings"]').click();
    } else {
        await page.locator('.nav-item[data-section="settings"]').click();
    }
    await page.locator('[data-action="settings-restart"]').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    if (narrow(page)) {
        expect(await page.evaluate(() => document.activeElement.className)).toContain('modal-content');
    } else {
        await expect(page.locator('#modal-cancel-btn')).toBeFocused();
    }
});

test('a dropdown list in a dialog is above it and can be picked from; Escape closes the list, not the dialog', async ({
    page
}) => {
    await mockPanel(page);
    await openChatSettings(page);
    await page.locator('.custom-select:has(#chat-settings-timezone) .custom-select-trigger').click();
    const option = page.locator('.custom-select-option').nth(1);
    await expect(option).toBeVisible();
    expect(await onTop(option)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.custom-select-panel')).toHaveCount(0);
    await expect(page.locator('#chat-settings-modal')).toBeVisible();

    // Escape again: the settings dialog goes, back to the chat's menu it was opened from
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-settings-modal')).toBeHidden();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
});

test('on a computer focus goes into the dialog and back to the button that opened it', async ({ page }) => {
    test.skip(narrow(page), 'a keyboard and mouse');
    await mockPanel(page);
    const opener = page.locator('#popular-list [data-action="series"]').first();
    await opener.focus();
    await page.keyboard.press('Enter');
    const card = page.locator('#detail-modal');
    await expect(card).toBeVisible();
    expect(await card.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(opener).toBeFocused();
});

test('on a touch screen opening a dialog focuses its box, not a field: no keyboard, no ring', async ({ page }) => {
    test.skip(!narrow(page), 'a touch screen');
    await mockPanel(page);
    await openChatSettings(page);
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.className);
    expect(focused).toContain('modal-content');
});

/** Elements showing a focus ring: focused for the keyboard and drawn with an outline. */
const rings = (page) =>
    page.evaluate(
        () =>
            [...document.querySelectorAll(':focus-visible')].filter(
                (el) => getComputedStyle(el).outlineStyle !== 'none'
            ).length
    );

test('on a touch screen closing a dialog leaves no focus ring on what opened it', async ({ page }) => {
    test.skip(!narrow(page), 'a touch screen');
    await mockPanel(page);
    await page.locator('.tab-item[data-section="subs"]').tap();
    await page.locator('#subs-body .compact-title').first().tap();
    await expect(page.locator('#detail-modal')).toBeVisible();
    await page.locator('#detail-modal .modal-x').tap();
    await expect(page.locator('#detail-modal')).toBeHidden();
    expect(await rings(page)).toBe(0);

    // One dialog over another: the one left open keeps focus on its box, not on a ringed button
    await openChatSettings(page);
    await page.locator('#chat-settings-modal [data-close-return="chat-settings-modal"]').first().tap();
    await expect(page.locator('#chat-actions-modal')).toBeVisible();
    expect(await rings(page)).toBe(0);
});

test('scrolling in an open dialog leaves the page behind it where it was', async ({ page }) => {
    await mockPanel(page);
    // Room to scroll, so a page that moves shows it
    await page.evaluate(() => {
        document.body.style.minHeight = '3000px';
        window.scrollTo(0, 200);
    });
    // Opened from code: a click would scroll the page to what it clicks first
    await page.evaluate(() => import('./js/ui.js').then((ui) => ui.openModal('detail-modal')));
    const card = page.locator('#detail-modal');
    await expect(card).toBeVisible();
    const root = () => page.evaluate(() => getComputedStyle(document.documentElement).overflowY);
    expect(await root()).toBe('hidden');
    // Locking it doesn't throw it back to the top
    expect(await page.evaluate(() => window.scrollY)).toBe(200);
    // Where the browser knows the property (Safari 16+ does; Playwright's WebKit on Windows doesn't)
    const overscroll = await card
        .locator('.modal-content')
        .evaluate((el) =>
            CSS.supports('overscroll-behavior', 'contain') ? getComputedStyle(el).overscrollBehaviorY : 'contain'
        );
    expect(overscroll).toBe('contain');

    // A real wheel over the dialog: the mobile WebKit project has no wheel, the styles above cover it
    if (!narrow(page)) {
        const box = await card.locator('.modal-content').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
        await page.mouse.move(box.x - 10 > 0 ? box.x - 10 : 5, 5);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => window.scrollY)).toBe(200);
    }

    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    expect(await root()).not.toBe('hidden');
    expect(await page.evaluate(() => window.scrollY)).toBe(200);
});

test('on a phone the More sheet slides up from the bottom without jumping', async ({ page }) => {
    test.skip(!narrow(page), 'the phone sheet');
    await mockPanel(page);
    // Every frame while it opens: the sheet's top edge and how far the dialog is scrolled
    await page.evaluate(() => {
        const sheet = document.getElementById('more-modal');
        window.__frames = [];
        const tick = () => {
            if (sheet.open) {
                const top = sheet.querySelector('.modal-content').getBoundingClientRect().top;
                window.__frames.push({ top, scroll: sheet.scrollTop });
            }
            if (window.__frames.length < 30) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    await page.locator('.tab-item[data-open="more-modal"]').click();
    await page.waitForFunction(() => window.__frames.length >= 30);
    const frames = await page.evaluate(() => window.__frames);
    // Focus moving in must not scroll it: a sheet still below the edge would jump up and back
    expect(Math.max(...frames.map((f) => f.scroll))).toBe(0);
    // And it rises: the top edge only ever moves up, from lower than where it ends
    const tops = frames.map((f) => f.top);
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeLessThanOrEqual(tops[i - 1] + 1);
    expect(tops[0]).toBeGreaterThan(tops[tops.length - 1]);
});
