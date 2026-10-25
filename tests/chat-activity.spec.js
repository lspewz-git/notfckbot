const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, isPhone } = require('./helpers');
const { mockPanel, chatStats } = require('./mock-panel');

/**
 * Chats that left the bot (blocked it, removed it from the group) and when each chat last used it
 * (src/bot-status.js): the Users / Chats tabs and columns, the dashboard's Chats card and the
 * chat's Statistics. On the canned API (mock-panel.js).
 */

watchConsole();

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600e3;
const DAY = 24 * HOUR;
// Dates with no year: within this year, whatever day the suite runs
const thisYear = (month, day) => new Date(new Date().getFullYear(), month - 1, day, 12).toISOString();

const chat = (id, username, type, fields = {}) => ({
    id,
    username,
    type,
    blockedUntil: null,
    menu_enabled: true,
    buttons_mode: 'owner',
    bot_status: 'active',
    bot_status_at: null,
    bot_status_by: null,
    last_seen_at: null,
    ...fields
});

const CHATS = [
    chat(101, '@alice', 'private', { last_seen_at: ago(2 * HOUR) }),
    chat(102, '@bob', 'private', { bot_status: 'stopped', bot_status_at: thisYear(1, 12), last_seen_at: ago(40 * DAY) }),
    chat(-1004, 'Friday series', 'group', {
        bot_status: 'removed',
        bot_status_at: thisYear(1, 20),
        bot_status_by: '@masha'
    }),
    chat(106, '@ivan', 'private', { bot_status_at: thisYear(1, 22), last_seen_at: ago(5 * 60e3) })
];

const tab = (page, name) => page.locator(`.tab-filters [data-chats-tab="${name}"]`);
const rowOf = (page, id) => page.locator('#chats-body tr', { has: page.locator(`[data-id="${id}"]`) });

async function goToChats(page) {
    await openSection(page, 'chats');
    await expect(page.locator('#chats-body .skeleton-row')).toHaveCount(0, { timeout: 15_000 });
}

test('who left the bot and when each chat was last active', async ({ page }) => {
    await mockPanel(page, { chats: CHATS });
    await goToChats(page);
    await expect(tab(page, 'all')).toHaveText('All (4)');
    await expect(tab(page, 'active')).toHaveText('Active (2)');
    await expect(tab(page, 'left')).toHaveText('Left the bot (2)');
    await expect(page.locator('#chats-body tr')).toHaveCount(4);

    const status = (id) => rowOf(page, id).locator('[data-label="Status"]');
    await expect(status(102)).toHaveText('Stopped the botsince 12 Jan');
    await expect(status(-1004)).toHaveText('Removed from groupby @masha · 20 Jan');
    await expect(status(106)).toHaveText('Activecame back 22 Jan');
    await expect(status(101)).toHaveText('Active');
    const seen = (id) => rowOf(page, id).locator('[data-label="Last active"]');
    await expect(seen(101)).toHaveText('2 h ago');
    await expect(seen(106)).toHaveText('5 min ago');
    // Never seen since recording began
    await expect(seen(-1004)).toHaveText('-');

    if (isPhone(page)) {
        // The phone's card: the badge by the name, "active …" after the type and id, the note under it
        const card = rowOf(page, 102).locator('.cell-compact');
        await expect(card.locator('.compact-head .badge')).toHaveText('Stopped the bot');
        await expect(card.locator('.compact-meta').nth(1)).toHaveText('since 12 Jan');
        await expect(rowOf(page, 101).locator('.compact-meta')).toHaveText('private · 101 · active 2 h ago');
    } else {
        await expect(page.locator('#chats-table th')).toHaveText([
            'Chat ID',
            'User / Group',
            'Type',
            'Status',
            'Last active',
            'Actions'
        ]);
    }

    await tab(page, 'left').click();
    await expect(page.locator('#chats-left-hint')).toBeVisible();
    await expect(page.locator('#chats-body tr [data-action="chat-actions"]')).toHaveCount(2);
    await expect(rowOf(page, 102)).toHaveCount(1);
    await expect(rowOf(page, -1004)).toHaveCount(1);

    await tab(page, 'active').click();
    await expect(page.locator('#chats-left-hint')).toBeHidden();
    await expect(page.locator('#chats-body tr [data-action="chat-actions"]')).toHaveCount(2);
    await expect(rowOf(page, 101)).toHaveCount(1);
});

test('a chat blocked in the panel says until when; no chat left: the Left tab says so', async ({ page }) => {
    const until = new Date(Date.now() + 2 * DAY);
    await mockPanel(page, { chats: [chat(105, '@kate', 'private', { blockedUntil: until.toISOString() })] });
    await goToChats(page);
    await expect(rowOf(page, 105).locator('[data-label="Status"] .badge')).toHaveText('Blocked');
    await expect(rowOf(page, 105).locator('.status-note')).toContainText('until ');
    await tab(page, 'left').click();
    await expect(page.locator('#chats-body')).toHaveText('No chat has left the bot.');
});

test("the dashboard's Chats card: how many left, beside the new ones", async ({ page }) => {
    await mockPanel(page, { stats: { chatsLeft: 2 } });
    await expect(page.locator('#chats-left-count')).toHaveText('2 left');
    await expect(page.locator('#chats-delta')).toHaveText('+2 new in 30 days');
});

test('none left: no aside on the card', async ({ page }) => {
    await mockPanel(page);
    await expect(page.locator('#chats-delta')).toHaveText('+2 new in 30 days');
    await expect(page.locator('#chats-left-count')).toBeHidden();
});

test("a group's Statistics: when it was last active, and the bot's comings and goings", async ({ page }) => {
    const bot = {
        status: 'active',
        since: thisYear(1, 22),
        lastSeen: ago(30 * HOUR),
        history: [
            { kind: 'bot_on', detail: 'added', by: '@ann', at: thisYear(1, 22) },
            { kind: 'bot_off', detail: 'removed', by: '@masha', at: thisYear(1, 20) }
        ]
    };
    // Yesterday just after midnight: the day before and over 24 h ago, so "yesterday", not "N h ago"
    const seenAt = new Date();
    seenAt.setDate(seenAt.getDate() - 1);
    seenAt.setHours(0, 1, 0, 0);
    const club = chat(-1003, 'Movie Club', 'supergroup', { last_seen_at: seenAt.toISOString() });
    await mockPanel(page, { chats: [club], chatStats: (query) => ({ ...chatStats(query), bot }) });
    await goToChats(page);
    await page.locator('[data-action="chat-actions"][data-id="-1003"]').click();
    await page.locator('#action-stats').click();
    await expect(page.locator('#chat-stats-modal')).toBeVisible();
    await expect(page.locator('#chat-stats-sub')).toHaveText('Movie Club · supergroup · active yesterday');
    const history = page
        .locator('#chat-stats-body .stats-subtitle', { hasText: 'Bot in this chat' })
        .locator('+ .stats-list .stats-row');
    await expect(history).toHaveText(['Added by @ann22 Jan', 'Removed by @masha20 Jan']);
});

test('no history yet: no "Bot in this chat"', async ({ page }) => {
    await mockPanel(page);
    await goToChats(page);
    await page.locator('[data-action="chat-actions"][data-id="-1003"]').click();
    await page.locator('#action-stats').click();
    await expect(page.locator('#chat-stats-body .stats-kpi-value').first()).toBeVisible();
    await expect(page.locator('#chat-stats-body .stats-subtitle', { hasText: 'Bot in this chat' })).toHaveCount(0);
});
