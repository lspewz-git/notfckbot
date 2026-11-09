const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, pickChat, openProfilePage, profileButton, openSection } = require('./helpers');

watchConsole();

async function pull(frame, ratio) {
    return frame.evaluate((el, ratio) => {
        const target = el.querySelector('h3, h2, p') || el;
        const top = el.getBoundingClientRect().top;
        const point = clientY => ({ identifier: 10, target, clientX: 140, clientY });
        const start = point(top + 48), end = point(top + 48 + el.clientHeight * ratio);
        let moved;
        for (const [type, touch, ended] of [['touchstart', start, false], ['touchmove', end, false], ['touchend', end, true]]) {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: ended ? [] : [touch] }, changedTouches: { value: [touch] } });
            target.dispatchEvent(event);
            if (type === 'touchmove') moved = el.getBoundingClientRect().top - top;
        }
        return { moved, released: el.getBoundingClientRect().top - top };
    }, ratio);
}

test('every registered sheet gets one grabber and the same phone dismissal', async ({ page, isMobile }) => {
    await mockPanel(page, { role: 'user' });
    const ids = await page.locator('dialog.modal-sheet').evaluateAll(dialogs => dialogs.map(el => el.id));
    expect(ids).toEqual(expect.arrayContaining(['pick-modal', 'more-modal', 'password-sheet', 'device-modal']));
    for (const id of ids) {
        await page.evaluate(async id => {
            const modal = document.getElementById(id);
            if (!modal.querySelector('.modal-content')) modal.innerHTML = '<div class="modal-content sheet-content"></div>';
            const frame = modal.querySelector('.modal-content');
            // Empty dynamic sheets need content only for this shared-lifecycle fixture.
            if (!frame.textContent.trim()) frame.innerHTML = '<p>Sheet content fixture</p>';
            const { openModal } = await import('/js/ui.js');
            openModal(id);
        }, id);
        const modal = page.locator(`#${id}`), frame = modal.locator('.modal-content');
        await frame.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        await expect(frame.locator('.sheet-grabber')).toHaveCount(1);
        if (isMobile) await expect(frame.locator('.sheet-grabber')).toBeVisible();
        else await expect(frame.locator('.sheet-grabber')).toBeHidden();
        const top = Math.round((await frame.boundingBox()).y);
        const short = await pull(frame, 0.29);
        if (isMobile) {
            expect(short.moved, id).toBeGreaterThan(0);
            expect(Math.abs(short.moved - short.released), id).toBeLessThan(1);
        } else expect(short.moved, id).toBe(0);
        await expect.poll(async () => Math.round((await frame.boundingBox()).y)).toBe(top);
        await pull(frame, 0.31);
        if (!isMobile) await page.evaluate(async id => { await (await import('/js/ui.js')).closeModal(id); }, id);
        await expect(modal).toBeHidden();
    }
});

test('Buttons pressed by dismisses by swipe without saving; the next choice still saves', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone-only gesture');
    const panel = await mockPanel(page, { role: 'user', groupAdmin: true, path: '/#my-subs' });
    await pickChat(page, 'my-subs', 'Киноклуб');
    await openProfilePage(page, 'my-settings');
    const opener = page.locator('[data-action="mine-pick"][data-name="buttons_mode"]');
    await opener.click();
    const modal = page.locator('#pick-modal'), frame = modal.locator('.modal-content');
    await frame.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    await expect(frame.locator('.sheet-grabber')).toBeVisible();
    await pull(frame, 0.31);
    await expect(modal).toBeHidden();
    expect(panel.account.sent.filter(r => r.method === 'PATCH')).toHaveLength(0);
    await opener.click();
    await modal.getByRole('option', { name: 'Every member' }).click();
    await expect(modal).toBeHidden();
    await expect.poll(() => panel.account.sent.filter(r => r.method === 'PATCH').length).toBe(1);
    expect(panel.account.sent.find(r => r.method === 'PATCH').body).toEqual({ buttons_mode: 'all' });
});

test('every personal header opens the same Account page as the navigation item', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page, { role: 'user', path: '/#my-calendar' });
    for (const section of ['my-calendar', 'my-aired', 'my-subs']) {
        await openSection(page, section);
        const chip = profileButton(page, section);
        await expect(chip).toHaveAttribute('href', '#my-profile');
        await expect(chip).not.toHaveAttribute('aria-haspopup', 'dialog');
        await expect(chip.locator('svg')).toHaveCount(0);
        if (process.env.SHARED_SHEET_CAPTURES && section === 'my-calendar') {
            await page.locator(`#${section}-section header`).screenshot({ path: `previews/account-header-${isMobile ? 'mobile' : 'desktop'}.png` });
        }
        await chip.click();
        await expect(page.locator('#my-profile-section')).toHaveClass(/active/);
        await expect(page).toHaveURL(/#my-profile$/);
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    }
    await openProfilePage(page, 'my-settings');
    await page.locator('[data-action="mine-pick"][data-name="quiet"]').click();
    await page.locator('#pick-modal .modal-content').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    if (process.env.SHARED_SHEET_CAPTURES) await page.locator('#pick-modal .modal-content').screenshot({ path: `previews/shared-picker-${isMobile ? 'mobile' : 'desktop'}.png` });
});

test('a direct sheet-to-dialog swap cannot reopen a dialog after Escape', async ({ page }) => {
    await mockPanel(page);
    await page.evaluate(async () => { (await import('/js/ui.js')).openModal('more-modal'); });
    await page.locator('#more-modal .modal-content').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const swapped = await page.evaluate(() => {
        const menu = document.querySelector('#more-modal');
        const frame = menu.querySelector('.modal-content');
        // Hold the outgoing animation: the next dialog must not depend on this animation finishing later.
        const animate = frame.animate.bind(frame);
        frame.animate = (...args) => { const animation = animate(...args); animation.pause(); return animation; };
        menu.querySelector('[data-open="about-modal"]').click();
        const opened = document.querySelector('#about-modal').open;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return opened;
    });
    expect(swapped).toBe(true);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
});
