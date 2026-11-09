const { test, expect } = require('@playwright/test');
const { watchConsole, openSection, isNarrow } = require('./helpers');
const { mockPanel } = require('./mock-panel');

// The final logout can race an in-flight authenticated refresh, which correctly receives 401; the
// chats test makes Telegram fail with 503, the Devices tests refuse a sign-out (403).
watchConsole({ ignore: /status of (401|403|404|503)/ });

// Every admin header's chip: a link to the Account tab (redesign v2)
const adminProfile = (page) => page.locator('.section.active [data-admin-profile] a');

test('every admin section has a profile chip to the Account tab instead of the rail view picker and sign out', async ({
    page
}) => {
    await mockPanel(page);
    await expect(page.locator('.view-switch, .sidebar [data-action="logout"]')).toHaveCount(0);
    for (const section of ['dashboard', 'chats', 'subs', 'watchlist', 'history', 'recap', 'logs', 'settings']) {
        await openSection(page, section);
        const chip = adminProfile(page);
        await expect(chip).toBeVisible();
        const fits = await chip.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth;
        });
        expect(fits).toBe(true);
        await expect(chip).toHaveAttribute('href', '#my-profile');
    }
    await adminProfile(page).click();
    await expect(page.locator('#my-profile-section')).toHaveClass(/active/);
    await expect(page.locator('#my-profile-body [data-action="profile-signout"]')).toBeVisible();
    await expect(page.locator('#my-profile-body [data-action="view-admin"]')).toBeVisible();
});

test('the Account tab picks a chat for the personal pages and Admin panel returns to the previous admin section', async ({
    page
}) => {
    await mockPanel(page);
    await openSection(page, 'logs');
    await adminProfile(page).click();
    await page.locator('#my-profile-body .chat-row', { hasText: 'Киноклуб' }).click();
    await expect(page.locator('#my-calendar-section')).toBeVisible();
    await expect(page.locator('#my-profile-body .chat-row', { hasText: 'Киноклуб' })).toHaveAttribute(
        'aria-pressed',
        'true'
    );
    await openSection(page, 'my-profile');
    await page.locator('#my-profile-body [data-action="view-admin"]').click();
    await expect(page.locator('#logs-section')).toBeVisible();
    await adminProfile(page).click();
    await page.locator('#my-profile-body [data-section="my-account"]').last().click();
    await expect(page.locator('#my-account-section')).toBeVisible();
    await page.locator('#my-account-section .mine-back').click();
    await expect(page.locator('#my-profile-section')).toBeVisible();
});

test('local admin has profile settings, password and devices, without Telegram choices', async ({ page }) => {
    const panel = await mockPanel(page, { system: true });
    await adminProfile(page).click();
    const body = page.locator('#my-profile-body');
    await expect(body.locator('.profile-card')).toContainText('admin');
    await expect(body.locator('.profile-card')).toContainText('Local account');
    await expect(body.locator('.chat-row, [data-section="my-settings"]')).toHaveCount(0);
    await body.locator('[data-section="my-account"]').last().click();
    await expect(page.locator('#my-account-info')).toContainText('Local account');
    await expect(page.locator('#my-account-info')).not.toContainText('Telegram');
    await page.locator('#my-signin [data-action="access-system-password"]').click();
    await expect(page.locator('#password-modal')).toBeVisible();
    await page.locator('#password-new').fill('system-pass');
    await page.locator('#password-again').fill('system-pass');
    await page.locator('#password-form [type="submit"]').click();
    await expect(page.locator('#password-modal')).toBeHidden();
    expect(panel.systemPasswords).toEqual(['system-pass']);
    // The local account has the Devices page too
    await page.locator('#my-devices [data-action="devices-open"]').click();
    await expect(page.locator('#my-devices-section')).toHaveClass(/active/);
    await page.locator('[data-action="devices-end-others"]').click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast-success').last()).toContainText('Signed out of other sessions');
    await page.locator('#my-devices-section .page-back').click();
    await page.reload();
    await expect(page.locator('#my-account-section')).toBeVisible();
    // Account settings has the round Back of the new pages, not the profile chip
    await expect(page.locator('#my-account-section .page-back')).toBeVisible();
    await expect(page.locator('#my-account-section [data-admin-profile]')).toHaveCount(0);
    await page.locator('#my-account-section .mine-back').click();
    await expect(page.locator('#my-profile-section')).toBeVisible();
    await body.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#login-gate')).toBeVisible();
    expect(panel.account.sent.some((r) => r.path === '/api/account/chats')).toBe(false);
});

const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
// Yesterday, over a day ago, whatever the hour now (30 hours ago is two days back before 6 am)
const yesterdayEarly = () => {
    const at = new Date();
    at.setDate(at.getDate() - 1);
    at.setHours(0, 30, 0, 0);
    return at.toISOString();
};
const DEVICES = [
    { id: '1'.repeat(24), name: 'Chrome, Windows', country: 'RU', network: 'Beeline', current: true, seenAt: ago(0) },
    { id: '2'.repeat(24), name: 'Safari, iPhone', country: 'RU', network: 'MTS', current: false, seenAt: ago(2) },
    {
        id: '3'.repeat(24),
        name: 'Telegram, iPhone',
        country: 'RU',
        network: 'MTS',
        current: false,
        seenAt: yesterdayEarly()
    },
    { id: '4'.repeat(24), name: 'Firefox, Mac', country: 'DE', network: 'Hetzner', current: false, seenAt: ago(80) },
    { id: '5'.repeat(24), name: 'Edge, Windows', country: 'RU', network: null, current: false, seenAt: ago(90) },
    { id: '6'.repeat(24), name: null, country: null, network: null, current: false, seenAt: ago(100) }
];

/** Account settings → the Devices row → its page */
async function openDevices(page) {
    await adminProfile(page).click();
    await page.locator('#my-profile-body [data-section="my-account"]').last().click();
    const entry = page.locator('#my-devices [data-action="devices-open"]');
    await expect(entry).toContainText('6 active');
    // The group isn't clipped: the keyboard ring is drawn whole (redesign handoff)
    expect(await entry.evaluate((el) => getComputedStyle(el.closest('.group-list')).overflow)).toBe('visible');
    await entry.click();
    await expect(page.locator('#my-devices-section')).toHaveClass(/active/);
}

test('Devices: this device on its own card, the others in a list with Show more and no Sign out per row', async ({
    page
}) => {
    await mockPanel(page, { devices: DEVICES });
    await openDevices(page);
    const body = page.locator('#devices-body');
    const card = body.locator('.group-card');
    await expect(card).toContainText('Chrome, Windows');
    // Back's circle (5px inside its 44px target) on the card's left edge, then the title on the same
    // row, as large as Following's (approved 06.11, variant B)
    const lefts = await page.evaluate(() => {
        const box = (sel) => document.querySelector(sel).getBoundingClientRect();
        const back = box('#my-devices-section .page-back');
        const title = box('#my-devices-section h1');
        const card = box('#devices-body .group-card');
        const size = (sel) => getComputedStyle(document.querySelector(sel)).fontSize;
        return {
            circle: Math.round(back.left + 5),
            card: Math.round(card.left),
            gap: Math.round(title.left - back.right),
            row: Math.round(Math.abs(title.top + title.height / 2 - back.top - back.height / 2)),
            font: [size('#my-devices-section h1'), size('#my-subs-section h1')],
            size: [back.width, back.height]
        };
    });
    expect(lefts.circle).toBe(lefts.card);
    expect(lefts.gap).toBe(4);
    expect(lefts.row).toBeLessThanOrEqual(1);
    expect(lefts.font[0]).toBe(lefts.font[1]);
    expect(lefts.size).toEqual([44, 44]);
    // As wide as the other account pages: the column of the section, not a narrow strip
    const widths = await page.evaluate(() => ({
        card: document.querySelector('#devices-body .group-card').getBoundingClientRect().width,
        section: document.querySelector('#my-devices-section').getBoundingClientRect().width
    }));
    expect(Math.round(widths.card)).toBe(Math.round(widths.section));
    await expect(card).toContainText('This device · Active now');
    await expect(card).toContainText('Russia, Beeline');
    await expect(card.locator('button')).toHaveCount(0);
    await expect(body.locator('[data-action="devices-end-others"]')).toHaveText('Sign out of other sessions');
    await expect(body.locator('.group-title')).toHaveText('Other sessions · 5');

    const rows = body.locator('.group-list [data-action="device-open"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Safari, iPhone');
    await expect(rows.nth(0)).toContainText('Russia, MTS · 2 hours ago');
    await expect(rows.nth(1)).toContainText('yesterday');
    await expect(rows.nth(2)).toContainText('Germany, Hetzner');
    await expect(body.locator('.group-list')).not.toContainText('Sign out');
    // Every row is one button at least 52px high (redesign handoff); no rule over the first one
    const sizes = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(52);
    const firstRule = await body
        .locator('.group-list > li')
        .first()
        .evaluate((el) => getComputedStyle(el, '::before').content);
    expect(firstRule).toBe('none');
    // Sentence case, not capitals
    expect(await body.locator('.group-title').evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');

    await body.locator('[data-action="devices-more"]').click();
    await expect(rows).toHaveCount(5);
    await expect(rows.last()).toContainText('Unknown browser');
    await expect(body.locator('[data-action="devices-more"]')).toHaveCount(0);

    // Back to Account settings
    await page.locator('#my-devices-section .page-back').click();
    await expect(page.locator('#my-account-section')).toHaveClass(/active/);
});

test('Devices: a row opens its sheet; Sign out this device keeps the sheet on an error and drops the row', async ({
    page
}) => {
    const panel = await mockPanel(page, { devices: DEVICES, deviceEndFails: [403] });
    await openDevices(page);
    const rows = page.locator('#devices-body .group-list [data-action="device-open"]');
    await rows.first().click();
    const sheet = page.locator('#device-modal');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.locator('#device-title')).toHaveText('Safari, iPhone');
    await expect(sheet.locator('.sheet-details')).toContainText('LocationRussia');
    await expect(sheet.locator('.sheet-details')).toContainText('NetworkMTS');
    await expect(sheet.locator('.sheet-details')).toContainText('Last active2 hours ago');

    // Refused (a device signed in today): the sheet stays with the reason, the button is free again
    const out = sheet.locator('[data-action="device-end"]');
    await out.click();
    await expect(sheet.locator('#device-error')).toContainText('one day after its first sign-in');
    await expect(sheet).toBeVisible();
    await expect(out).toBeEnabled();

    await out.click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('.toast-success').last()).toContainText('Signed out');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#devices-body .group-list')).not.toContainText('Safari, iPhone');
    await expect(page.locator('#devices-body .group-title')).toHaveText('Other sessions · 4');
    const ends = panel.account.sent.filter(
        (r) => r.method === 'DELETE' && r.path === `/api/account/sessions/${'2'.repeat(24)}`
    );
    expect(ends).toHaveLength(2);

    // Cancel just closes
    await rows.first().click();
    await sheet.locator('.sheet-btn-secondary').click();
    await expect(sheet).toBeHidden();
});

test('Devices: the keyboard opens a sheet, Escape closes it and focus returns to the row', async ({ page }) => {
    test.skip(isNarrow(page), 'a keyboard');
    await mockPanel(page, { devices: DEVICES });
    await openDevices(page);
    const row = page.locator('#devices-body .group-list [data-action="device-open"]').nth(1);
    await row.focus();
    await page.keyboard.press('Enter');
    const sheet = page.locator('#device-modal');
    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('device-modal').contains(document.activeElement))).toBe(
        true
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(row).toBeFocused();
    // A keyboard ring on it, not on what was clicked
    expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

    // Signed out from the keyboard: focus moves to the row that took its place, not to the page
    await page.keyboard.press('Enter');
    await sheet.locator('[data-action="device-end"]').focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeHidden();
    await expect(page.locator('#devices-body')).not.toContainText('Telegram, iPhone');
    await expect(page.locator('#devices-body .group-list [data-action="device-open"]').nth(1)).toBeFocused();

    // Signing out of the others leaves focus on the page's title
    await page.locator('[data-action="devices-end-others"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('#devices-body')).toContainText('No other active sessions');
    await expect(page.locator('#devices-heading')).toBeFocused();
});

test('Devices: a device already signed out elsewhere (404) is just dropped', async ({ page }) => {
    await mockPanel(page, { devices: DEVICES, deviceEndFails: [404] });
    await openDevices(page);
    await page.locator('#devices-body .group-list [data-action="device-open"]').first().click();
    await page.locator('#device-modal [data-action="device-end"]').click();
    await expect(page.locator('#device-modal')).toBeHidden();
    await expect(page.locator('.toast-success').last()).toContainText('Signed out');
    await expect(page.locator('#devices-body .group-list')).not.toContainText('Safari, iPhone');
});

// A fresh page each: a second goto to the same page would only change the hash, not reload
for (const [who, options] of [
    ['a user', { role: 'user' }],
    ['the local account', { system: true }]
]) {
    test(`Devices opens straight from the address after a reload, for ${who}`, async ({ page }) => {
        await mockPanel(page, { ...options, devices: DEVICES, path: '/#my-devices' });
        await expect(page.locator('#my-devices-section')).toHaveClass(/active/);
        await expect(page.locator('#devices-body .group-card')).toContainText('Chrome, Windows');
        await expect(page.locator('#devices-body .group-list [data-action="device-open"]')).toHaveCount(4);
        await page.locator('#my-devices-section .page-back').click();
        await expect(page.locator('#my-account-section')).toHaveClass(/active/);
    });
}

test('Devices: no focus ring on a touch screen, even for focus the page moves itself', async ({ page }) => {
    test.skip(!isNarrow(page), 'a touch screen');
    await mockPanel(page, { devices: DEVICES });
    await openDevices(page);
    const row = page.locator('#devices-body .group-list [data-action="device-open"]').first();
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#device-modal')).toBeVisible();
    await page.locator('#device-modal .sheet-close').focus();
    expect(
        await page.evaluate(
            () =>
                [...document.querySelectorAll(':focus-visible')].filter(
                    (el) => getComputedStyle(el).outlineStyle !== 'none'
                ).length
        )
    ).toBe(0);
    await page.keyboard.press('Escape');
    await row.focus();
    expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
});

test('Devices: Sign out of other sessions asks first, then leaves the empty state', async ({ page }) => {
    const panel = await mockPanel(page, { devices: DEVICES });
    await openDevices(page);
    await page.locator('[data-action="devices-end-others"]').click();
    await expect(page.locator('#confirm-title')).toHaveText('Sign out of 5 other sessions?');
    await page.locator('#modal-confirm-btn').click();
    await expect(page.locator('.toast-success').last()).toContainText('Signed out of other sessions');
    expect(panel.account.sent.filter((r) => r.path === '/api/account/sessions/end-others')).toHaveLength(1);
    await expect(page.locator('#devices-body')).toContainText('No other active sessions');
    await expect(page.locator('#devices-body .group-title')).toHaveText('Other sessions · 0');
    await expect(page.locator('[data-action="devices-end-others"]')).toHaveCount(0);
    await expect(page.locator('#devices-body .group-card')).toContainText('Chrome, Windows');
});

test('Devices: a failed load says so and Try again loads it', async ({ page }) => {
    await mockPanel(page, { devices: DEVICES, devicesFails: [503, 503] });
    await adminProfile(page).click();
    await page.locator('#my-profile-body [data-section="my-account"]').last().click();
    await page.locator('#my-devices [data-action="devices-open"]').click();
    const body = page.locator('#devices-body');
    await expect(body.locator('[role="alert"]')).toContainText('Devices failed (503)');
    await body.locator('[data-action="devices-retry"]').click();
    await expect(body.locator('.group-card')).toContainText('Chrome, Windows');
    await expect(body.locator('.group-list [data-action="device-open"]')).toHaveCount(4);
});

test('every tab label fits inside the capsule on a 320px phone', async ({ page }) => {
    test.skip(!isNarrow(page), 'the phone tab bar');
    await page.setViewportSize({ width: 320, height: 640 });
    for (const options of [{}, { role: 'user', path: '/#my-subs' }]) {
        await mockPanel(page, options);
        await expect(page.locator('.tabbar .tab-item:visible').first()).toBeVisible();
        const tabs = await page.evaluate(() =>
            [...document.querySelectorAll('.tabbar .tab-item')]
                .filter((t) => t.offsetParent)
                .map((t) => ({
                    text: t.textContent.trim(),
                    fits: [...t.querySelectorAll('span:not(.sr-only)')].every((s) => s.scrollWidth <= t.clientWidth)
                }))
        );
        for (const tab of tabs) expect(tab.fits, tab.text).toBe(true);
    }
});

test('the phone tab bar floats as a capsule and the page ends above it', async ({ page }) => {
    test.skip(!isNarrow(page), 'the phone tab bar');
    await mockPanel(page, { devices: DEVICES });
    await openDevices(page);
    await page.locator('#devices-body [data-action="devices-more"]').click();
    const bar = await page.locator('.tabbar').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        return {
            left: r.left,
            right: innerWidth - r.right,
            bottom: innerHeight - r.bottom,
            height: r.height,
            radius: css.borderRadius,
            position: css.position
        };
    });
    expect(bar).toEqual({ left: 12, right: 12, bottom: 12, height: 56, radius: '28px', position: 'fixed' });
    const active = page.locator('.tabbar .tab-item.active');
    // Devices is nested under Account: its tab is current ("true"), not the page itself
    await expect(active).toHaveAttribute('aria-current', 'true');

    // Scrolled to the end, the last row and the hint still clear the bar
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const gap = await page.evaluate(() => {
        const top = document.querySelector('.tabbar').getBoundingClientRect().top;
        const last = document.querySelector('#devices-body .group-list').getBoundingClientRect().bottom;
        return top - last;
    });
    expect(gap).toBeGreaterThanOrEqual(24);
});

test('the Account tab draws the chats in when they arrive, from same-size skeleton rows', async ({ page }) => {
    let finish;
    const chatsWait = new Promise((resolve) => {
        finish = resolve;
    });
    await mockPanel(page, { chatsWait });
    await adminProfile(page).click();
    const body = page.locator('#my-profile-body');
    const skeletons = body.locator('.chat-row[aria-hidden="true"]');
    await expect(skeletons).toHaveCount(2);
    await expect(body.locator('[data-action="profile-chat"]')).toHaveCount(0);
    const skeletonHeight = await skeletons.first().evaluate((el) => el.getBoundingClientRect().height);
    finish();
    await expect(body.locator('[data-action="profile-chat"]').first()).toBeVisible();
    await expect(body.locator('[data-section="my-settings"]')).toBeVisible();
    await expect(skeletons).toHaveCount(0);
    const rowHeight = await body
        .locator('[data-action="profile-chat"]')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(rowHeight - skeletonHeight)).toBeLessThan(1);
});

test('chats failing on the Account tab show a retry that loads them', async ({ page }) => {
    let finish;
    const chatsWait = new Promise((resolve) => {
        finish = resolve;
    });
    const panel = await mockPanel(page, { chatsWait, chatsDown: true });
    await adminProfile(page).click();
    const body = page.locator('#my-profile-body');
    await expect(body.locator('.chat-row[aria-hidden="true"]').first()).toBeVisible();
    finish();
    const retry = body.locator('[data-action="mine-reload"]');
    await expect(retry).toContainText("Couldn't load chats");
    await expect(body.locator('.chat-row[aria-hidden="true"]')).toHaveCount(0);
    panel.account.chatsDown = false;
    await retry.click();
    await expect(body.locator('[data-action="profile-chat"]').first()).toBeVisible();
    await expect(retry).toHaveCount(0);
});

test('Chat settings, Account settings and Devices titles sit level with Following, 16px over the content', async ({
    context
}) => {
    // Higher on a phone it went under Telegram's blurred top edge, and Chat settings' card touched it (06.11)
    const measure = async (id) => {
        const page = await context.newPage();
        await mockPanel(page, { role: 'user', path: `/#${id}` });
        const title = page.locator(`#${id}-section h1`);
        await expect(title).toBeVisible();
        return title.evaluate((h) => {
            const box = h.getBoundingClientRect();
            const header = h.closest('header');
            let next = header.nextElementSibling;
            while (next && !next.getBoundingClientRect().height) next = next.nextElementSibling;
            return {
                centre: box.top + box.height / 2,
                gap: Math.round(next.getBoundingClientRect().top - header.getBoundingClientRect().bottom)
            };
        });
    };
    const following = await measure('my-subs');
    for (const id of ['my-profile', 'my-settings', 'my-account', 'my-devices']) {
        const page_ = await measure(id);
        expect(Math.abs(page_.centre - following.centre), id).toBeLessThanOrEqual(1);
        expect(page_.gap, id).toBe(16);
    }
});
