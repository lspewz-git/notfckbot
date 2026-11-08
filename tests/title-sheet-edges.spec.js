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
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await scroll.evaluate(el => { el.scrollTop = 160; });
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
