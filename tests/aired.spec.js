const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, pickChat, profileButton } = require('./helpers');

watchConsole();

test('Released shows this chat’s released titles, filters, years and cards without admin requests', async ({
    page
}) => {
    const panel = await mockPanel(page, { role: 'user' });
    await openSection(page, 'my-aired');
    const body = page.locator('#my-aired-body');
    await expect(body.locator('.mine-row')).toHaveCount(2);
    await expect(body).toContainText('Season 2');
    await body.locator('[data-action="mine-aired-what"][data-what="films"]').click();
    await expect(body.locator('.mine-row')).toHaveCount(1);
    await body.locator('.mine-row').click();
    await expect(page.locator('#mine-card-modal')).toContainText('Released film');
    await expect(page.locator('#mine-card-modal').getByRole('link', { name: 'Kinopoisk' })).toHaveAttribute('href', 'https://www.kinopoisk.ru/film/9/');
    await page.locator('#mine-card-modal [data-close]').click();
    await body.locator('[data-action="mine-aired-year"][data-year="2025"]').click();
    await expect(body).toContainText('No releases in this category in 2025.');
    await body.locator('[data-action="mine-aired-what"][data-what="all"]').click();
    await expect(body).toContainText('Season 1');
    await pickChat(page, 'my-aired', 'Киноклуб');
    await expect(body).toContainText('Group release');
    await expect(body).toContainText('Season 2');
    await expect(body).not.toContainText('Одни из нас');
    expect(panel.account.sent.every((r) => r.path.startsWith('/api/account/'))).toBe(true);
    await profileButton(page, 'my-aired').click();
    await expect(page.locator('#profile-modal [data-action="view-admin"]')).toHaveCount(0);
});

for (const kind of ['series', 'films']) {
    test(`Released ${kind} shares the Following card without subscription controls`, async ({ page }) => {
        await mockPanel(page, { role: 'user' });
        await openSection(page, 'my-aired');
        await page.locator(`[data-action="mine-aired-what"][data-what="${kind}"]`).click();
        await page.locator('#my-aired-body .mine-row').click();
        const card = page.locator('#mine-card-modal');
        await expect(card.locator('.mine-following-card')).toBeVisible();
        await expect(card.locator('.title-rating')).toContainText(kind === 'series' ? '8.6' : '7.4');
        await expect(card).toContainText(kind === 'series' ? 'Season 2' : 'In Russian cinemas');
        await expect(card).not.toContainText('Next episode');
        await expect(card).not.toContainText('When the film is out');
        await expect(card.locator('.mine-modes')).toHaveCount(0);
        await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toHaveCount(0);
        await expect(card.getByRole('link', { name: 'Watch on SSPoisk' })).toBeVisible();
        const overview = card.locator('.mine-overview');
        const before = await overview.innerText();
        await card.getByRole('button', { name: 'Show more' }).click();
        expect((await overview.innerText()).length).toBeGreaterThan(before.length);
        await card.getByRole('button', { name: 'Show less' }).click();
        await expect(overview).toHaveText(before, { useInnerText: true });
        const boxes = await card.evaluate(el => {
            const content = el.querySelector('.mine-following-card').getBoundingClientRect();
            const links = [...el.querySelectorAll('.mine-links a')].map(a => a.getBoundingClientRect());
            return { width: window.innerWidth, left: content.left, right: content.right, links: links.map(r => ({ left: r.left, right: r.right })) };
        });
        expect(boxes.left).toBeGreaterThanOrEqual(0);
        expect(boxes.right).toBeLessThanOrEqual(boxes.width);
        expect(boxes.links.every(r => r.left >= boxes.left && r.right <= boxes.right)).toBe(true);
    });
}

test('Released deep link survives reload', async ({ page }) => {
    await mockPanel(page, { role: 'user', path: '/#my-aired' });
    await expect(page.locator('#my-aired-section')).toHaveClass(/active/);
    await expect(page.locator('#my-aired-body .mine-row')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('#my-aired-section')).toHaveClass(/active/);
    await expect(page.locator('#my-aired-body .mine-row')).toHaveCount(2);
});

test('the bottom avatar opens reachable account actions on tablets', async ({ page, isMobile }) => {
    test.skip(isMobile, 'one explicit tablet viewport');
    await page.setViewportSize({ width: 800, height: 900 });
    await mockPanel(page, { path: '/#my-aired' });
    await profileButton(page, 'my-aired').click();
    const admin = page.locator('#profile-modal [data-action="view-admin"]');
    await expect(admin).toBeVisible();
    const box = await admin.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect(
        await admin.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        })
    ).toBe(true);
    await admin.click();
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
});
