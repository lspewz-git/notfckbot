const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, openSettingsTab } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/** Settings → Bot → Panel access, and the way there from a chat's menu, on the canned API. */

// A refused save is a 4xx the browser reports itself
watchConsole({ ignore: /status of 4\d\d/ });

async function openAccess(page) {
    await openSection(page, 'settings');
    await openSettingsTab(page, 'bot');
    await expect(page.locator('#access-list .access-row')).not.toHaveCount(0);
}

async function pick(page, select, text) {
    await page.locator(`.custom-select:has(${select}) .custom-select-trigger`).click();
    await page.locator('.custom-select-panel .custom-select-option', { hasText: text }).first().click();
}

const row = (page, id) => page.locator(`.access-row[data-id="${id}"]`);

test('you are listed without controls; adding someone saves at once and lists them', async ({ page }) => {
    const panel = await mockPanel(page);
    await openAccess(page);
    await expect(row(page, '101')).toContainText('alice');
    await expect(row(page, '101')).toContainText('101 · you');
    // Your own role can't be changed or taken away here
    await expect(row(page, '101').locator('select, button')).toHaveCount(0);

    await pick(page, '#access-add-role', 'Admin');
    await page.locator('#access-add').click();
    await expect(page.locator('.toast-success')).toHaveText('bob can sign in as Admin.');
    expect(panel.accessSaves).toEqual([{ userId: '102', role: 'admin' }]);
    await expect(row(page, '102').locator('select.access-role')).toHaveValue('admin');
    // Nobody left to add
    await expect(page.locator('#access-add')).toBeDisabled();
});

test('a role changes when picked; removing asks first and puts the person back to add', async ({ page }) => {
    const panel = await mockPanel(page, {
        access: {
            people: [
                { id: '101', name: 'alice', role: 'admin', you: true },
                { id: '102', name: 'bob', role: 'user', you: false }
            ],
            candidates: []
        }
    });
    await openAccess(page);
    await pick(page, '.access-role[data-id="102"]', 'Admin');
    await expect(page.locator('.toast-success')).toHaveText('bob is Admin now.');
    expect(panel.accessSaves).toEqual([{ userId: '102', role: 'admin' }]);

    await row(page, '102').locator('[data-action="access-remove"]').click();
    await expect(page.locator('#confirm-text')).toContainText("bob won't be able to sign in");
    await page.locator('#modal-confirm-btn').click();
    await expect(row(page, '102')).toHaveCount(0);
    expect(panel.accessSaves.at(-1)).toEqual({ userId: '102', role: 'none' });
    await expect(page.locator('#access-add-user')).toHaveValue('102');
});

test('a refused change says why and shows the saved role again', async ({ page }) => {
    await mockPanel(page, {
        access: {
            people: [
                { id: '101', name: 'alice', role: 'admin', you: true },
                { id: '102', name: 'bob', role: 'user', you: false }
            ],
            candidates: []
        },
        accessSave: () => ({ status: 400, body: { error: "This person hasn't written to the bot yet" } })
    });
    await openAccess(page);
    await pick(page, '.access-role[data-id="102"]', 'Admin');
    await expect(page.locator('.toast-error')).toHaveText("This person hasn't written to the bot yet");
    await expect(row(page, '102').locator('select.access-role')).toHaveValue('user');
});

test('Users / Chats: a role on the row; the menu leads to the person in Settings', async ({ page }) => {
    const chat = (id, username, type, panelRole) => ({
        id,
        username,
        type,
        panelRole,
        blockedUntil: null,
        bot_status: 'active',
        last_seen_at: null
    });
    await mockPanel(page, {
        chats: [
            chat(101, 'alice', 'private', 'admin'),
            chat(102, 'bob', 'private', null),
            chat(-1003, 'Movie Club', 'supergroup', null)
        ]
    });
    await openSection(page, 'chats');
    await expect(page.locator('#chats-body .access-badge:visible', { hasText: 'Admin' })).toHaveCount(1);

    // A group can't sign in: no access row
    await page.locator('[data-action="chat-actions"][data-id="-1003"]').click();
    await expect(page.locator('#action-access')).toBeHidden();
    await page.locator('[data-close="chat-actions-modal"].modal-x').click();

    await page.locator('[data-action="chat-actions"][data-id="102"]').click();
    await expect(page.locator('#action-access-desc')).toHaveText('No access');
    await page.locator('#action-access').click();
    await expect(page.locator('#settings-pane-bot')).toBeVisible();
    // bob has no role yet: picked to be added
    await expect(page.locator('#access-add-user')).toHaveValue('102');

    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await expect(page.locator('#action-access-desc')).toHaveText('Admin');
    await page.locator('#action-access').click();
    await expect(row(page, '101')).toHaveClass(/access-row-wanted/);
});

test("someone's password is marked in the list and removed after a confirmation", async ({ page }) => {
    const panel = await mockPanel(page, {
        access: {
            people: [
                { id: '101', name: 'alice', role: 'admin', you: true, password: true },
                { id: '103', name: 'carol', role: 'user', you: false, password: true }
            ],
            candidates: []
        }
    });
    await openAccess(page);
    await expect(row(page, '103')).toContainText('103 · password');
    // Your own password is on your account page
    await expect(row(page, '101').locator('[data-action="access-password-remove"]')).toHaveCount(0);
    await row(page, '103').locator('[data-action="access-password-remove"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Remove the password?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast-success')).toHaveText('carol has no password now.');
    expect(panel.passwordRemoved).toEqual(['103']);
    await expect(row(page, '103')).not.toContainText('password');
    await expect(row(page, '103').locator('[data-action="access-password-remove"]')).toHaveCount(0);
});
