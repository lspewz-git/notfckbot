const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { openSection, watchConsole } = require('./helpers');

watchConsole();

async function openLongCard(page) {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.series[0].overview = 'Native scrolling should keep its momentum and leave room for the scrollbar. '.repeat(140);
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    const card = page.locator('#mine-card-body');
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    await card.locator('.tc-more').click();
    await card.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return card;
}

test('scrollbar has a separate lane beside the full-width title content', async ({ page }) => {
    const card = await openLongCard(page);
    await expect.poll(() => card.locator('.tc-scroll').evaluate(el => {
        const r = el.getBoundingClientRect();
        const edge = Math.max(...[...el.children].map(child => child.getBoundingClientRect().right));
        return { space: r.right - edge, overflow: el.scrollWidth > el.clientWidth };
    })).toEqual({ space: expect.any(Number), overflow: false });
    expect(await card.locator('.tc-scroll').evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.right - Math.max(...[...el.children].map(child => child.getBoundingClientRect().right));
    })).toBeGreaterThanOrEqual(8);
});

async function touchSession(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    return async (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }]
    });
}

test('an upward finger scroll stays native through browser pointer cancellation', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP supplies real touch input; WebKit state transitions are covered separately');
    const card = await openLongCard(page);
    await card.evaluate(el => {
        const scroll = el.querySelector('.tc-scroll');
        window.nativeScroll = { writes: 0, cancels: 0 };
        const position = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        Object.defineProperty(scroll, 'scrollTop', {
            get() { return position.get.call(this); },
            set(value) { window.nativeScroll.writes++; position.set.call(this, value); }
        });
        scroll.addEventListener('pointercancel', () => window.nativeScroll.cancels++);
    });
    const touch = await touchSession(page);
    const r = await card.locator('.tc-scroll').boundingBox();
    const x = r.x + r.width / 2, y = r.y + r.height * 0.8;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) {
        await touch('touchMove', x, y - i * 18);
        // Gesture sampling interval, not a test timeout or a wait for an application outcome.
        await page.waitForTimeout(16);
    }
    await touch('touchEnd');
    await expect.poll(() => card.locator('.tc-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    const motion = await page.evaluate(() => window.nativeScroll);
    expect(motion.writes).toBe(0);
    expect(motion.cancels).toBeGreaterThan(0);
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await expect(card).toHaveCSS('transform', 'none');
});

test('a scrolled body keeps its native gesture when it reaches the top and reverses', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Real touch input via CDP');
    const card = await openLongCard(page);
    await card.locator('.tc-scroll').evaluate(el => { el.scrollTop = 80; });
    const frame = await card.boundingBox();
    const touch = await touchSession(page);
    const x = frame.x + frame.width / 2, y = frame.y + frame.height * 0.5;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) await touch('touchMove', x, y + i * 15);
    await expect.poll(() => card.locator('.tc-scroll').evaluate(el => el.scrollTop)).toBeLessThan(10);
    for (let i = 1; i <= 10; i++) await touch('touchMove', x, y + 120 - i * 18);
    await touch('touchEnd');
    await expect.poll(() => card.locator('.tc-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(50);
    expect(await card.boundingBox()).toEqual(frame);
    await expect(card).toHaveCSS('transform', 'none');
});

test('small diagonal jitter does not abandon a downward dismissal', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Real touch input via CDP');
    const card = await openLongCard(page);
    const touch = await touchSession(page);
    const r = await card.boundingBox();
    const x = r.x + r.width / 2, y = r.y + 50;
    await touch('touchStart', x, y);
    await touch('touchMove', x + 2, y + 1);
    for (let i = 1; i <= 12; i++) await touch('touchMove', x + 3, y + r.height * 0.56 * i / 12);
    await touch('touchEnd');
    await expect(page.locator('#mine-card-modal')).toBeHidden();
});

test('a fresh touch can press Close immediately after a short pull returns', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Real touch input via CDP');
    const card = await openLongCard(page);
    const touch = await touchSession(page);
    const r = await card.boundingBox();
    const x = r.x + r.width / 2, y = r.y + 50;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 4; i++) await touch('touchMove', x, y + i * 20);
    await touch('touchEnd');
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const close = await card.locator('.sheet-close').boundingBox();
    await touch('touchStart', close.x + close.width / 2, close.y + close.height / 2);
    await touch('touchEnd');
    await expect(page.locator('#mine-card-modal')).toBeHidden();
});

// These events exercise the same TouchEvent interface in WebKit as well as Chromium; physical input above is CDP-only.
async function sequence(card, steps) {
    return card.evaluate((el, steps) => {
        const target = el.querySelector('.tc-head');
        return steps.map(({ type, y = 100, touches = 1 }) => {
            const points = Array.from({ length: touches }, (_, i) => ({ identifier: i, target, clientX: 100 + i * 50, clientY: y }));
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
                touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : points },
                changedTouches: { value: [{ identifier: 0, target, clientX: 100, clientY: y }] }
            });
            target.dispatchEvent(event);
            return { prevented: event.defaultPrevented, top: el.getBoundingClientRect().top, open: el.closest('dialog').open };
        });
    }, steps);
}

test('an interrupted return can be grabbed again without snapping away from the finger', async ({ page }) => {
    const card = await openLongCard(page);
    const top = (await card.boundingBox()).y;
    await sequence(card, [{ type: 'touchstart' }, { type: 'touchmove', y: 200 }, { type: 'touchend', y: 200 }]);
    await card.evaluate(el => { const a = el.getAnimations()[0]; a.pause(); a.currentTime = 100; });
    const returning = (await card.boundingBox()).y;
    expect(returning).toBeGreaterThan(top);
    const [grab, move] = await sequence(card, [{ type: 'touchstart' }, { type: 'touchmove', y: 140 }]);
    expect(grab.top).toBeCloseTo(returning, 2);
    expect(move.top).toBeCloseTo(returning + 40, 2);
    expect(move.prevented).toBe(true);
    await sequence(card, [{ type: 'touchend', y: 140 }]);
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    expect((await card.boundingBox()).y).toBeCloseTo(top, 2);
    await expect(page.locator('#mine-card-modal')).toBeVisible();
});

test('multi-touch cancels the pull and cannot dismiss when the first finger ends', async ({ page }) => {
    const card = await openLongCard(page);
    const frame = await card.boundingBox();
    const moved = 100 + frame.height * 0.6;
    const result = await sequence(card, [
        { type: 'touchstart' }, { type: 'touchmove', y: moved },
        { type: 'touchstart', y: moved, touches: 2 }, { type: 'touchend', y: moved }
    ]);
    expect(result[1].prevented).toBe(true);
    expect(result[2].prevented).toBe(false);
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    expect(await card.boundingBox()).toEqual(frame);
});

test('a second finger on the exposed backdrop also cancels dismissal', async ({ page }) => {
    const card = await openLongCard(page);
    const frame = await card.boundingBox();
    const y = 100 + frame.height * 0.6;
    await sequence(card, [{ type: 'touchstart' }, { type: 'touchmove', y }]);
    await card.evaluate((el, y) => {
        const modal = el.closest('dialog');
        const event = new Event('touchstart', { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
            touches: { value: [{ identifier: 0, clientX: 100, clientY: y }, { identifier: 1, clientX: 20, clientY: 20 }] },
            changedTouches: { value: [{ identifier: 1, clientX: 20, clientY: 20 }] }
        });
        modal.dispatchEvent(event);
    }, y);
    await sequence(card, [{ type: 'touchend', y }]);
    await expect(page.locator('#mine-card-modal')).toBeVisible();
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    expect(await card.boundingBox()).toEqual(frame);
});
