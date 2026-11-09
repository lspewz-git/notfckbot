const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openProfilePage } = require('./helpers');

watchConsole({ ignore: /status of 503/ });

// The Account tab's chats (redesign v2): rows that switch, and Hidden chats → the visibility dialog
const rows = (page) => page.locator('#my-profile-body [data-action="profile-chat"]');
const hiddenRow = (page) => page.locator('#my-profile-body [data-action="profile-visibility"]');

async function visibility(page) {
    await openProfilePage(page, 'my-profile');
    await hiddenRow(page).click();
    await expect(page.locator('#visibility-modal')).toBeVisible();
    await page.locator('#visibility-modal .modal-content').evaluate(el =>
        Promise.all(el.getAnimations().map(animation => animation.finished)));
}

async function pullVisibility(page, ratio, { cancel = false, list = false } = {}) {
    return page.locator('#visibility-modal .modal-content').evaluate((frame, { ratio, cancel, list }) => {
        const target = frame.querySelector(list ? '#visibility-list .row-name' : '.visibility-header h3');
        const top = frame.getBoundingClientRect().top;
        const point = y => ({ identifier: 7, target, clientX: 100, clientY: y });
        const start = point(top + 44), end = point(top + 44 + frame.clientHeight * ratio);
        let moved = 0;
        for (const [type, touch, ended] of [
            ['touchstart', start, false], ['touchmove', end, false], [cancel ? 'touchcancel' : 'touchend', end, true]
        ]) {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: ended ? [] : [touch] }, changedTouches: { value: [touch] } });
            target.dispatchEvent(event);
            if (type === 'touchmove') moved = frame.getBoundingClientRect().top - top;
        }
        return { moved, released: frame.getBoundingClientRect().top - top, open: frame.closest('dialog').open };
    }, { ratio, cancel, list });
}

test('Hidden chats uses the shared sheet header, grouped rows and phone grabber', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page, { role: 'user' });
    await visibility(page);
    const frame = page.locator('#visibility-modal .modal-content');
    await expect(page.locator('#visibility-title')).toHaveText('Hidden chats');
    await expect(page.locator('#visibility-list > li > .group-row')).toHaveCount(2);
    await expect(page.locator('#visibility-list .row-check')).toHaveCSS('color', 'rgb(95, 208, 138)');
    const layout = await frame.evaluate(el => {
        const frame = el.getBoundingClientRect();
        const title = el.querySelector('h3').getBoundingClientRect();
        const close = el.querySelector('.sheet-close').getBoundingClientRect();
        const list = el.querySelector('#visibility-list').getBoundingClientRect();
        return { centre: title.x + title.width / 2 - frame.x - frame.width / 2, close: [close.width, close.height],
            top: frame.top, bottom: frame.bottom, listInside: list.left >= frame.left && list.right <= frame.right };
    });
    expect(Math.abs(layout.centre)).toBeLessThan(1);
    expect(layout.close).toEqual([44, 44]);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(page.viewportSize().height + 1);
    expect(layout.listInside).toBe(true);
    if (isMobile) await expect(frame.locator('.visibility-grabber')).toBeVisible();
    else await expect(frame.locator('.visibility-grabber')).toBeHidden();
    if (process.env.HIDDEN_CAPTURE) await frame.screenshot({ path: `previews/hidden-chats-actual-${isMobile ? 'mobile' : 'desktop'}.png` });
});

test('phone pulls return below 30%, cancel safely and dismiss above 30%', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone-only gesture');
    await mockPanel(page, { role: 'user' });
    await visibility(page);
    const frame = page.locator('#visibility-modal .modal-content');
    const top = Math.round((await frame.boundingBox()).y);
    const short = await pullVisibility(page, 0.29);
    expect(short.moved).toBeGreaterThan(50);
    expect(Math.abs(short.moved - short.released)).toBeLessThan(1);
    await expect.poll(async () => Math.round((await frame.boundingBox()).y)).toBe(top);
    expect((await pullVisibility(page, 0.6, { cancel: true })).open).toBe(true);
    await expect.poll(async () => Math.round((await frame.boundingBox()).y)).toBe(top);
    expect((await pullVisibility(page, 0.31, { list: true })).moved).toBeGreaterThan(50);
    await expect(page.locator('#visibility-modal')).toBeHidden();
    await hiddenRow(page).click();
    await expect(page.locator('#visibility-modal')).toBeVisible();
    await page.getByRole('switch', { name: 'Show Киноклуб' }).click();
    await expect(page.getByRole('switch', { name: 'Show Киноклуб' })).toHaveAttribute('aria-checked', 'false');
});

test('scrolling a long phone list keeps the sheet in place', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone scroll/drag handoff');
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.chats.push(...Array.from({ length: 40 }, (_, i) => ({ id: String(-200 - i), title: `Group ${i}`, type: 'supergroup', hidden: true })));
    await page.reload();
    await visibility(page);
    const list = page.locator('#visibility-list');
    await list.evaluate(el => { el.scrollTop = 180; });
    expect((await pullVisibility(page, 0.6, { list: true })).moved).toBe(0);
    await expect(page.locator('#visibility-modal')).toBeVisible();
    await list.evaluate(el => { el.scrollTop = 0; });
    await pullVisibility(page, 0.31, { list: true });
    await expect(page.locator('#visibility-modal')).toBeHidden();
});

test('reopening an exiting visibility sheet cancels its old close; reduced motion is immediate', async ({ page }) => {
    await mockPanel(page, { role: 'user' });
    await visibility(page);
    await page.evaluate(async () => {
        const { closeModal } = await import('/js/ui.js');
        const { profileActions } = await import('/js/profile.js');
        const done = closeModal('visibility-modal');
        profileActions['profile-visibility']();
        await done;
    });
    await expect(page.locator('#visibility-modal')).toBeVisible();
    await expect(page.locator('#visibility-modal')).not.toHaveAttribute('inert', '');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(async () => {
        const { closeModal } = await import('/js/ui.js');
        closeModal('visibility-modal');
        if (document.querySelector('#visibility-modal').open) throw new Error('Reduced-motion close must be immediate');
    });
});

test('Chromium native touch scrolls the list and dismisses from the header', async ({ page, isMobile }) => {
    test.skip(isMobile, 'CDP touch input is Chromium-only');
    await page.setViewportSize({ width: 375, height: 812 });
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.chats.push(...Array.from({ length: 40 }, (_, i) => ({ id: String(-200 - i), title: `Group ${i}`, type: 'supergroup', hidden: true })));
    await page.reload();
    await visibility(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    async function swipe(x, y, distance) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 12; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * i / 12 }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    const frame = page.locator('#visibility-modal .modal-content');
    const original = await frame.boundingBox();
    const list = page.locator('#visibility-list');
    const listBox = await list.boundingBox();
    await swipe(140, listBox.y + listBox.height - 60, -150);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(80);
    expect(Math.round((await frame.boundingBox()).y)).toBe(Math.round(original.y));
    const title = await page.locator('#visibility-title').boundingBox();
    await swipe(140, title.y + 12, original.height * 0.35);
    await expect(page.locator('#visibility-modal')).toBeHidden();
    await cdp.detach();
});

test('hide and restore through Hidden chats; the count shows; persists after reload', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await openProfilePage(page, 'my-profile');
    await expect(hiddenRow(page)).toContainText('Hidden chats');
    await expect(hiddenRow(page).locator('.row-value')).toHaveCount(0);
    await rows(page).filter({ hasText: 'Киноклуб' }).click();
    await visibility(page);
    await expect(page.locator('#visibility-list [role="switch"]')).toHaveCount(1);
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(panel.account.chats.find((c) => c.id === '-100').hidden).toBe(true);
    await page.locator('#visibility-modal [data-close]').click();
    // Hiding the open group returns to the first visible chat
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(hiddenRow(page).locator('.row-value')).toHaveText('1');
    await page.reload();
    await openProfilePage(page, 'my-profile');
    await expect(rows(page)).toHaveCount(1);
    await hiddenRow(page).click();
    await expect(page.locator('#visibility-modal')).toBeVisible();
    await page.getByRole('switch', { name: 'Show Киноклуб' }).click();
    await expect(page.getByRole('switch', { name: 'Show Киноклуб' })).toHaveAttribute('aria-checked', 'true');
    await page.locator('#visibility-modal [data-close]').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(hiddenRow(page).locator('.row-value')).toHaveCount(0);
});

test('failed save leaves the chat visible and can be retried; long list stays inside the dialog', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await expect(page.locator('#my-subs-body button.title-row').first()).toBeVisible();
    panel.account.chats.push(
        ...Array.from({ length: 40 }, (_, i) => ({
            id: String(-200 - i),
            title: `Group ${i}`,
            type: 'supergroup',
            settings: false,
            hidden: true
        }))
    );
    await page.reload();
    await visibility(page);
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    panel.account.visibilityError = true;
    await toggle.click();
    await expect(page.locator('.toast-error')).toContainText('Could not save visibility');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    panel.account.visibilityError = false;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await page.locator('#visibility-list').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const box = await page.locator('#visibility-modal .modal-content').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
    await page.getByRole('switch', { name: 'Show Group 39', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('switch', { name: 'Show Group 39', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Show Group 39', exact: true })).toHaveAttribute(
        'aria-checked',
        'true'
    );
});

test('reopening while saving keeps switches pending and shows the saved value', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await visibility(page);
    let finish;
    panel.account.visibilityWait = new Promise((resolve) => {
        finish = resolve;
    });
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    await toggle.click();
    await expect(toggle).toBeDisabled();
    await page.locator('#visibility-modal [data-close]').click();
    await hiddenRow(page).click();
    await expect(toggle).toBeDisabled();
    finish();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('restoring the only group selects it when there is no private chat', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await expect(page.locator('#my-subs-body button.title-row').first()).toBeVisible();
    panel.account.chats = panel.account.chats.filter((c) => c.type !== 'private');
    await page.reload();
    await visibility(page);
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.locator('#visibility-modal [data-close]').click();
    await expect(rows(page)).toHaveAttribute('aria-pressed', 'true');
});
