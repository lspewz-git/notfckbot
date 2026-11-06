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
}

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
