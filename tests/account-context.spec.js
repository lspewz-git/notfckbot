const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openAccount, openSection } = require('./helpers');

watchConsole();

for (const language of ['en', 'ru']) {
    const text =
        language === 'en'
            ? {
                  view: 'View',
                  open: 'Open personal view',
                  chats: 'Chats',
                  group: 'Group · admin',
                  helper: 'Open a chat to see its calendar, releases and following.'
              }
            : {
                  view: 'Режим',
                  open: 'Открыть личный раздел',
                  chats: 'Чаты',
                  group: 'Группа · администратор',
                  helper: 'Откройте чат, чтобы увидеть его календарь, вышедшее и подписки.'
              };

    test(`${language}: Account distinguishes admin mode from personal chat navigation`, async ({ page }) => {
        await page.addInitScript((lang) => localStorage.setItem('nfb.language', lang), language);
        await mockPanel(page, { language, groupAdmin: true });
        await openSection(page, 'logs');
        await openAccount(page);
        const body = page.locator('#my-profile-body');
        const admin = body.locator('[data-action="view-admin"]');
        const group = body.locator('.chat-row[data-id="-100"]');
        await expect(body.locator('#profile-view')).toHaveText(text.view);
        await expect(admin).toHaveAttribute('aria-pressed', 'true');
        await expect(admin.locator('.row-check')).toHaveCount(1);
        await expect(body.locator('.chat-row[aria-pressed="true"]')).toHaveCount(0);
        await expect(body.locator('.chat-row .row-chevron')).toHaveCount(2);
        await expect(body.locator('#profile-chats')).toHaveText(text.open);
        await expect(body.locator('.group-help').first()).toHaveText(text.helper);
        await expect(group.locator('.row-meta')).toHaveText(text.group);
        await expect(body).not.toContainText(/Current view|Вы сейчас здесь|you're|вы администратор/);
        await group.click();
        await expect(page.locator('#my-calendar-section')).toBeVisible();
        await openAccount(page);
        await expect(admin).toHaveAttribute('aria-pressed', 'false');
        await expect(admin.locator('.row-chevron')).toHaveCount(1);
        await expect(group).toHaveAttribute('aria-pressed', 'true');
        await expect(group.locator('.row-check')).toHaveCount(1);
        await expect(body.locator('#profile-chats')).toHaveText(text.chats);
        await admin.click();
        await expect(page.locator('#logs-section')).toBeVisible();
        await openAccount(page);
        await expect(admin).toHaveAttribute('aria-pressed', 'true');
        await expect(body.locator('.chat-row .row-check')).toHaveCount(0);
        await page.reload();
        await expect(admin).toHaveAttribute('aria-pressed', 'true');
        await expect(body.locator('.chat-row .row-check')).toHaveCount(0);
        await body.locator('.chat-row[data-id="42"]').click();
        await expect(page.locator('#my-calendar-section')).toBeVisible();
        await openAccount(page);
        await expect(body.locator('.chat-row[data-id="42"]')).toHaveAttribute('aria-pressed', 'true');
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/view-mine/);
        await expect(admin).toHaveAttribute('aria-pressed', 'false');
        await expect(body.locator('.chat-row[data-id="42"]')).toHaveAttribute('aria-pressed', 'true');
        const layout = await body.evaluate((el) => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
            rows: [...el.querySelectorAll('.group-row')].map((row) => {
                const b = row.getBoundingClientRect();
                return { left: b.left, right: b.right, height: b.height };
            })
        }));
        expect(layout.scroll).toBeLessThanOrEqual(layout.width);
        for (const row of layout.rows) {
            expect(row.left).toBeGreaterThanOrEqual(0);
            expect(row.right).toBeLessThanOrEqual(layout.width);
            expect(row.height).toBeGreaterThanOrEqual(44);
        }
    });

    test(`${language}: users have chat selection and system accounts have only admin mode`, async ({ page }) => {
        await page.addInitScript((lang) => localStorage.setItem('nfb.language', lang), language);
        await mockPanel(page, { role: 'user', language, groupAdmin: true });
        await openAccount(page);
        const body = page.locator('#my-profile-body');
        await expect(body.locator('#profile-view')).toHaveCount(0);
        await expect(body.locator('#profile-chats')).toHaveText(text.chats);
        await expect(body.locator('.chat-row[aria-pressed="true"]')).toHaveCount(1);
        await expect(body.locator('.chat-row[data-id="-100"] .row-meta')).toHaveText(text.group);
        await mockPanel(page, { system: true, language });
        await openAccount(page);
        await expect(body.locator('[data-action="view-admin"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(body.locator('.chat-row, #profile-chats')).toHaveCount(0);
    });
}
