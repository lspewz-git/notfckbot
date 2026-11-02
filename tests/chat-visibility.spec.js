const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, profileButton } = require('./helpers');

watchConsole({ ignore: /status of 503/ });

async function profile(page) {
    await profileButton(page, 'my-subs').click();
}

async function options(page) {
    await page.getByRole('button', { name: 'Chat display options', exact: true }).click();
    await expect(page.locator('#profile-options-menu')).toBeVisible();
    await page.locator('#profile-options-menu [data-action="profile-visibility"]').click();
    await expect(page.locator('#visibility-modal')).toBeVisible();
}

test('hide and restore through the dropdown or count shortcut; persists after reload', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await profile(page);
    const trigger = page.getByRole('button', { name: 'Chat display options', exact: true });
    await trigger.click();
    await expect(page.locator('#profile-options-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#profile-options-menu')).toHaveCount(0);
    await expect(page.locator('#profile-modal')).toBeVisible();
    await page.locator('#profile-modal [data-action="profile-chat"][data-id="-100"]').click();
    await profile(page);
    await options(page);
    await expect(page.locator('#visibility-list [role="switch"]')).toHaveCount(1);
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(panel.account.chats.find((c) => c.id === '-100').hidden).toBe(true);
    await page.locator('#visibility-modal [data-close]').click();
    await expect(page.locator('#profile-modal .pick-row')).toHaveCount(1);
    await expect(page.locator('#profile-modal .pick-row')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.profile-hidden')).toContainText('1');
    await page.reload();
    await profile(page);
    await expect(page.locator('#profile-modal .pick-row')).toHaveCount(1);
    await page.locator('.profile-hidden').click();
    await expect(page.locator('#visibility-modal')).toBeVisible();
    await page.getByRole('switch', { name: 'Show Киноклуб' }).click();
    await expect(page.getByRole('switch', { name: 'Show Киноклуб' })).toHaveAttribute('aria-checked', 'true');
    await page.locator('#visibility-modal [data-close]').click();
    await expect(page.locator('#profile-modal .pick-row')).toHaveCount(2);
    await expect(page.locator('.profile-hidden')).toHaveCount(0);
});

test('failed save leaves the chat visible and can be retried; long list stays inside the dialog', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await expect(page.locator('#my-subs-body .mine-row').first()).toBeVisible();
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
    await profile(page);
    await page.locator('.profile-hidden').click();
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
    await profile(page);
    await options(page);
    let finish;
    panel.account.visibilityWait = new Promise((resolve) => {
        finish = resolve;
    });
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    await toggle.click();
    await expect(toggle).toBeDisabled();
    await page.locator('#visibility-modal [data-close]').click();
    await options(page);
    await expect(toggle).toBeDisabled();
    finish();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('restoring the only group selects it when there is no private chat', async ({ page }) => {
    const panel = await mockPanel(page, { role: 'user', path: '/#my-subs' });
    await expect(page.locator('#my-subs-body .mine-row').first()).toBeVisible();
    panel.account.chats = panel.account.chats.filter((c) => c.type !== 'private');
    await page.reload();
    await profile(page);
    await options(page);
    const toggle = page.getByRole('switch', { name: 'Show Киноклуб' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.locator('#visibility-modal [data-close]').click();
    await expect(page.locator('#profile-modal .pick-row')).toHaveAttribute('aria-pressed', 'true');
});
