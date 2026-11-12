const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection } = require('./helpers');

watchConsole();

/** Holds the answer to adding a title until the returned release() */
async function holdAdding(page) {
    let release = () => {};
    const held = new Promise((resolve) => {
        release = resolve;
    });
    await page.route(/\/api\/account\/chats\/\d+\/(films|series)$/, async (route) => {
        await held;
        await route.fallback();
    });
    return () => release();
}

async function openSearch(page) {
    if (test.info().project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
    await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-subs');
    await page.getByRole('link', { name: 'Follow a title' }).click();
    await page.locator('#mine-q').fill('дюна');
    await page.locator('#mine-q').press('Enter');
    await expect(page.locator('#mine-results .search-row')).toHaveCount(3);
    await settled(page);
}

/** Waits out the page's opening fades (not the endless spinners and shimmers) so opacity and boxes are final */
const settled = (page) =>
    page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .map((a) => a.finished)
        )
    );

/** What a busy button shows: the label hidden, a spinner in the middle, no dimming, the same box */
const busyLook = (el) => {
    const spin = getComputedStyle(el, '::after');
    const box = el.getBoundingClientRect();
    const dot = (/** @type {Element} */ e) => {
        let opacity = 1;
        for (let n = e; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
        return opacity;
    };
    return {
        label: getComputedStyle(el).webkitTextFillColor,
        spinner: spin.animationName,
        size: [spin.width, spin.height],
        opacity: dot(el),
        box: [Math.round(box.width), Math.round(box.height)]
    };
};

test('a busy Follow pill shows a spinner instead of its label and keeps its size', async ({ page }) => {
    await openSearch(page);
    const release = await holdAdding(page);
    const pill = page.locator('#mine-results .search-row').nth(2).locator('.follow-btn > span');
    const before = await pill.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return [Math.round(b.width), Math.round(b.height)];
    });
    await pill.click();
    await expect(pill.locator('..')).toHaveAttribute('aria-busy', 'true');
    const look = await pill.evaluate(busyLook);
    expect(look).toMatchObject({
        label: 'rgba(0, 0, 0, 0)',
        spinner: 'spin',
        size: ['16px', '16px'],
        opacity: 1,
        box: before
    });
    if (process.env.BUSY_SHOTS)
        await page.locator('#mine-results .group-list').screenshot({
            path: `${process.env.BUSY_SHOTS}/${test.info().project.name}-pill.png`
        });
    release();
    await expect(page.locator('#mine-results .search-row').nth(2).locator('.search-following')).toHaveText('Following');
});

test('a busy sheet button shows a spinner instead of its label and keeps its size', async ({ page }) => {
    await openSearch(page);
    const release = await holdAdding(page);
    await page.locator('#mine-results .search-result-open').nth(2).click();
    // The sheet's opening animation scales and fades it: measure once it has settled
    await settled(page);
    const follow = page.locator('#mine-card-modal').getByRole('button', { name: 'Follow', exact: true });
    const before = await follow.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return [Math.round(b.width), Math.round(b.height)];
    });
    await follow.click();
    const busy = page.locator('#mine-card-modal [aria-busy="true"]');
    await expect(busy).toHaveCount(1);
    expect(await busy.evaluate(busyLook)).toMatchObject({
        label: 'rgba(0, 0, 0, 0)',
        spinner: 'spin',
        size: ['16px', '16px'],
        opacity: 1,
        box: before
    });
    if (process.env.BUSY_SHOTS)
        await page.locator('#mine-card-modal .tc-actions').screenshot({
            path: `${process.env.BUSY_SHOTS}/${test.info().project.name}-sheet.png`
        });
    release();
    await expect(page.locator('#mine-card-modal')).toBeHidden();
});
