const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { openSection, watchConsole } = require('./helpers');

watchConsole();

test('phone title content scrolls to both frame edges and keeps end spacing', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 390, height: 844 });
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.series[0].overview = 'A long description that must reach the sheet edges. '.repeat(100);
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    const card = page.locator('#mine-card-body');
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const scroll = card.locator('.tc-scroll');
    const measure = () => card.evaluate(el => {
        const frame = el.getBoundingClientRect();
        const scroller = el.querySelector('.tc-scroll').getBoundingClientRect();
        return { top: scroller.top - frame.top, bottom: frame.bottom - scroller.bottom };
    });
    const initial = await card.boundingBox();
    const grabber = card.locator('.tc-grabber');
    await expect(grabber).toBeVisible();
    await expect(grabber).toHaveAttribute('aria-hidden', 'true');
    const handle = await grabber.boundingBox();
    expect(handle.width).toBe(36);
    expect(handle.height).toBe(4);
    expect(handle.y - initial.y).toBe(9);
    expect(Math.abs(handle.x + handle.width / 2 - initial.x - initial.width / 2)).toBeLessThan(1);
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await scroll.evaluate(el => { el.scrollTop = 160; });
    expect(await grabber.boundingBox()).toEqual(handle);
    expect(await grabber.evaluate(el => {
        const r = el.getBoundingClientRect();
        return !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })).toBe(true);
    await expect.poll(measure).toEqual({ top: 1, bottom: 0 });
    expect(await card.boundingBox()).toEqual(initial);
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const action = card.getByRole('button', { name: 'Unfollow', exact: true });
    await expect(action).toBeInViewport({ ratio: 1 });
    expect(await card.evaluate(el => {
        const button = el.querySelector('.tc-actions').getBoundingClientRect();
        return el.getBoundingClientRect().bottom - button.bottom;
    })).toBeGreaterThanOrEqual(24);
    await scroll.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => card.locator('.tc-head').evaluate(el => el.getBoundingClientRect().top)).toBe(initial.y + 17);
});

test('desktop title cards hide the grabber', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Desktop breakpoint');
    await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    await expect(page.locator('#mine-card-body .tc-grabber')).toBeHidden();
});

test('dragging from the grabber closes the phone sheet', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP supplies actual touch input');
    await page.setViewportSize({ width: 390, height: 844 });
    const panel = await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    const card = page.locator('#mine-card-body');
    await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const handle = await card.locator('.tc-grabber').boundingBox();
    const frame = await card.boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x, y: y + frame.height * 0.55 * i / 10 }]
        });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#mine-card-modal')).toBeHidden();
    expect(panel.account.sent.filter(r => r.method === 'DELETE')).toHaveLength(0);
});
