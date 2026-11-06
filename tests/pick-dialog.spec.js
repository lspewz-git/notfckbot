const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, pickChat, profileButton, openProfilePage } = require('./helpers');

watchConsole();

async function checkHeader(sheet) {
    const close = sheet.getByRole('button', { name: 'Close', exact: true });
    await expect(close).toBeVisible();
    const layout = () =>
        close.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const title = button.parentElement.querySelector('h3').getBoundingClientRect();
            return {
                width: box.width,
                height: box.height,
                separate: title.right <= box.left,
                hit: button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 2))
            };
        });
    await expect.poll(layout).toEqual({ width: 44, height: 44, separate: true, hit: true });
    expect(await sheet.locator('.modal-content').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    return close;
}

for (const role of ['admin', 'user']) {
    test(`Chats has a close button and the admin switch matches the panel role (${role})`, async ({
        page,
        isMobile
    }, testInfo) => {
        const panel = await mockPanel(page, { role, groupAdmin: true, path: '/#my-subs' });
        if (process.env.PICK_SCREENSHOTS && !isMobile) await page.setViewportSize({ width: 1440, height: 900 });
        const sheet = page.locator('#pick-modal');
        await profileButton(page, 'my-subs').click();
        const close = await checkHeader(sheet);
        if (isMobile) await expect(sheet.locator('.modal-content')).toHaveCSS('border-bottom-left-radius', '0px');
        await expect(sheet.locator('#pick-admin')).toBeVisible({ visible: role === 'admin' });
        if (role === 'admin') await expect(sheet.locator('#pick-admin .action-icon')).toHaveCSS('border-width', '0px');
        if (process.env.PICK_SCREENSHOTS && role === 'admin')
            await sheet.locator('.modal-content').screenshot({ path: testInfo.outputPath('chats.png') });
        await close.click();
        await expect(sheet).toBeHidden();
        await expect(profileButton(page, 'my-subs')).toContainText('My account');
        expect(panel.account.sent.filter((r) => r.method === 'PATCH')).toHaveLength(0);

        // Opening another kind of choice must not retain the Chats admin action.
        await openProfilePage(page, 'my-settings');
        await page.locator('[data-action="mine-pick"][data-name="quiet"]').click();
        await expect(sheet.locator('#pick-admin')).toBeHidden();
        await sheet.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('#my-settings-body .chat-card').click();
        if (role === 'admin') {
            await sheet.locator('#pick-admin').click();
            await expect(sheet).toBeHidden();
            await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
        } else {
            await expect(sheet.locator('#pick-admin')).toBeHidden();
        }
    });
}

test('Buttons pressed by closes without saving and still saves a selected choice', async ({
    page,
    isMobile
}, testInfo) => {
    const panel = await mockPanel(page, { role: 'user', groupAdmin: true });
    if (process.env.PICK_SCREENSHOTS && !isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await pickChat(page, 'my-subs', 'Киноклуб');
    await openProfilePage(page, 'my-settings');
    const picker = page.locator('[data-action="mine-pick"][data-name="buttons_mode"]');
    const sheet = page.locator('#pick-modal');
    await picker.click();
    await expect(sheet.locator('h3')).toHaveText("Who presses the bot's buttons");
    const close = await checkHeader(sheet);
    await expect(sheet.locator('#pick-admin')).toBeHidden();
    if (process.env.PICK_SCREENSHOTS)
        await sheet.locator('.modal-content').screenshot({ path: testInfo.outputPath('buttons-pressed-by.png') });
    await close.click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#my-settings-section')).toHaveClass(/active/);
    expect(panel.account.sent.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    await picker.click();
    await sheet.getByRole('option', { name: 'Every member' }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => panel.account.sent.filter((r) => r.method === 'PATCH').length).toBe(1);
    expect(panel.account.sent.find((r) => r.method === 'PATCH').body).toEqual({ buttons_mode: 'all' });
});
