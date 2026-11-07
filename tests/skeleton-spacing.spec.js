const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection } = require('./helpers');

watchConsole();

for (const section of ['my-aired', 'my-calendar', 'my-subs']) {
    test(`${section} keeps initial skeleton clear of the search pill`, async ({ page }) => {
        if (test.info().project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
        let release;
        const chatsWait = new Promise((resolve) => {
            release = resolve;
        });
        try {
            await mockPanel(page, { role: 'user', path: `/#${section}`, chatsWait });
            await openSection(page, section);
            const list = page.locator(`#${section}-body > .group-list[aria-busy="true"]`);
            await expect(list).toBeVisible();
            const gap = await list.evaluate((el) => {
                const header = el.parentElement.previousElementSibling;
                return (
                    el.getBoundingClientRect().top - header.querySelector('.search-pill').getBoundingClientRect().bottom
                );
            });
            expect(gap).toBeCloseTo(16, 0);
            if (process.env.SKELETON_SHOTS && section === 'my-aired') {
                await page
                    .locator(`#${section}-section`)
                    .screenshot({ path: `${process.env.SKELETON_SHOTS}/${test.info().project.name}.png` });
            }
        } finally {
            release();
        }
        await expect(page.locator(`#${section}-body > .group-list[aria-busy="true"]`)).toHaveCount(0);
    });
}
