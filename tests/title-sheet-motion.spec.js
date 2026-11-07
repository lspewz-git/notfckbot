const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { openSection, watchConsole } = require('./helpers');

watchConsole();

async function following(page) {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.series[0].overview = 'A long description which should expand inside the same frame. '.repeat(100);
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    const card = page.locator('#mine-card-body');
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    return card;
}

test('description expansion preserves the frame and reading position while actions move down', async ({ page }) => {
    const card = await following(page);
    const measure = () => card.evaluate(el => {
        const r = el.getBoundingClientRect();
        const scroll = el.querySelector('.tc-scroll');
        return { top: r.top, height: r.height, scroll: scroll.scrollTop, page: scrollY };
    });
    const before = await measure();
    const actions = await card.locator('.tc-footer').boundingBox();
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect.poll(measure).toEqual(before);
    expect((await card.locator('.tc-footer').boundingBox()).y).toBeGreaterThan(actions.y + 200);
    await expect(card.locator('.tc-footer')).not.toBeInViewport();
    await card.locator('.tc-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(card.locator('.tc-footer')).toBeInViewport({ ratio: 1 });
    await card.getByRole('button', { name: 'Show less', exact: true }).click();
    await expect.poll(measure).toEqual(before);
});

// Synthetic pointer distances isolate the threshold from the physical screen's available drag space.
async function drag(card, fraction, cancel = false) {
    return card.evaluate((el, { fraction, cancel }) => {
        const y = el.getBoundingClientRect().top + 60;
        const target = el.querySelector('.tc-head');
        const pointer = { pointerId: 99, pointerType: 'touch', isPrimary: true, clientX: 100, bubbles: true };
        // Synthetic events have no browser pointer capture; real CDP gestures are covered separately.
        const capture = el.setPointerCapture;
        el.setPointerCapture = () => {};
        try {
            target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientY: y }));
            target.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientY: y + el.clientHeight * fraction }));
            const moved = el.getBoundingClientRect().top;
            target.dispatchEvent(new PointerEvent(cancel ? 'pointercancel' : 'pointerup', { ...pointer, clientY: y + el.clientHeight * fraction }));
            return { open: el.closest('dialog').open, moved, released: el.getBoundingClientRect().top };
        } finally { el.setPointerCapture = capture; }
    }, { fraction, cancel });
}

test('a drag below half returns smoothly; a drag above half animates out before closing', async ({ page }) => {
    const card = await following(page);
    const modal = page.locator('#mine-card-modal');
    const top = (await card.boundingBox()).y;
    const short = await drag(card, 0.49);
    expect(short.open).toBe(true);
    expect(short.released).toBeGreaterThan(top + 100);
    await expect.poll(async () => Math.round((await card.boundingBox()).y)).toBe(Math.round(top));
    const canceled = await drag(card, 0.6, true);
    expect(canceled.open).toBe(true);
    await expect.poll(async () => Math.round((await card.boundingBox()).y)).toBe(Math.round(top));
    const long = await drag(card, 0.51);
    expect(long.open).toBe(true);
    expect(long.released).toBeGreaterThan(top + 100);
    await expect(modal).toBeHidden();
});

test('reopening during exit cannot be closed by the old animation', async ({ page }) => {
    await following(page);
    await page.evaluate(async () => {
        const { closeModal, openModal } = await import('/js/ui.js');
        closeModal('mine-card-modal');
        const old = [...document.querySelectorAll('#mine-card-modal, #mine-card-body')].flatMap(el => el.getAnimations()).map(a => a.finished);
        openModal('mine-card-modal');
        await Promise.allSettled(old);
        await Promise.all(document.querySelector('#mine-card-body').getAnimations().map(a => a.finished));
    });
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await expect(page.locator('#mine-card-body')).toHaveCSS('opacity', '1');
    await page.keyboard.press('Escape');
    await expect(page.locator('#mine-card-modal')).toBeHidden();
});

test('closing an entire title-preview stack restores its original keyboard focus', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Touch intentionally leaves the page controls unfocused');
    await mockPanel(page);
    await openSection(page, 'chats');
    const opener = page.locator('[data-action="chat-actions"][data-id="101"]');
    await opener.click();
    await page.locator('#action-add').click();
    await page.locator('#content-search-input').fill('long title');
    await page.locator('#content-search-input').press('Enter');
    await page.locator('#content-search-results .search-result-open').first().click();
    await page.locator('#content-card-modal .sheet-close').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(opener).toBeFocused();
});

test('reduced motion closes immediately and short pulls stay open', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const card = await following(page);
    expect((await drag(card, 0.49)).open).toBe(true);
    expect((await drag(card, 0.51)).open).toBe(false);
});
