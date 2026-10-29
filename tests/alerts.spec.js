const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/** Settings → Alerts: one row per recipient, a dialog for what each gets, the rules and the log. */

// A 500 the browser reports itself: the test of a card that failed to load asks for one
watchConsole({ ignore: /500/ });

async function openAlerts(page, options = {}) {
    const panel = await mockPanel(page, options);
    await openSection(page, 'settings');
    await expect(page.locator('#settings-section')).toHaveClass(/active/);
    await expect(page.locator('#alerts-people')).not.toHaveAttribute('aria-busy', 'true');
    // The rest of Settings loaded too: nothing moves under a dropdown later (a scroll closes it)
    await expect(page.locator('#settings-masked-telegram')).toHaveText('8123*****xYz4');
    return panel;
}

const row = (page, name) => page.locator('.alert-person', { hasText: name });
const dialog = (page) => page.locator('#alert-person-modal');
const eventSwitch = (page, label) => dialog(page).locator('.alert-event', { hasText: label });

test('a row per recipient: what it gets in a word, and whether the bot can reach it', async ({ page }) => {
    await openAlerts(page);
    await expect(row(page, 'alice').locator('.alert-sum')).toHaveText(/Everything/);
    await expect(row(page, 'alice').locator('.alert-meta')).toHaveText('Last alert 2 h ago');
    await expect(row(page, 'Movie Club').locator('.alert-sum')).toHaveText(/2 of 14/);
    await expect(row(page, 'Movie Club').locator('.alert-meta')).toHaveText("Can't reach: Removed from group · 28 Oct");
    await expect(row(page, 'Movie Club').locator('.alert-tag')).toHaveText('group');
    // The rows hold no switches however many events there are: those are in the dialog
    await expect(page.locator('#alerts-people .alert-event')).toHaveCount(0);
    await expect(page.locator('#alerts-log li').first()).toContainText('Fixed: TMDB not answering');
    await expect(page.locator('#alerts-log li').nth(1)).toContainText('alice, 1 not reached');
    await expect(page.locator('#alerts-down-minutes')).toHaveValue('10');
    await expect(page.locator('#alerts-fixed')).toHaveAttribute('aria-checked', 'true');
});

test('a switch in the dialog makes the choice custom; Save keeps exactly what is on', async ({ page }) => {
    const panel = await openAlerts(page);
    await row(page, 'alice').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('[data-preset="all"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog(page).locator('.alert-event[aria-checked="true"]')).toHaveCount(14);

    await eventSwitch(page, 'Kinopoisk daily quota used up').click();
    await expect(dialog(page).locator('[data-preset="custom"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(eventSwitch(page, 'Kinopoisk daily quota used up')).toHaveAttribute('aria-checked', 'false');
    await expect(
        dialog(page).locator('.alert-group', { hasText: 'Services' }).locator('.alert-group-head')
    ).toContainText('4 of 5');

    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page)).toBeHidden();
    const save = panel.alerts.saves.at(-1);
    expect(save.preset).toBe('custom');
    expect(save.events).toHaveLength(13);
    expect(save.events).not.toContain('kinopoisk_quota');
    await expect(row(page, 'alice').locator('.alert-sum')).toHaveText(/13 of 14/);
});

test('a preset turns on its events; Critical only saves without a list', async ({ page }) => {
    const panel = await openAlerts(page);
    await row(page, 'alice').click();
    await dialog(page).locator('[data-preset="critical"]').click();
    // Critical events only: the red dots
    const on = dialog(page).locator('.alert-event[aria-checked="true"]');
    await expect(on).toHaveCount(await dialog(page).locator('.alert-event:has(.is-critical)').count());
    await expect(on.locator('.alert-dot:not(.is-critical)')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    expect(panel.alerts.saves.at(-1)).toEqual({ chatId: '101', preset: 'critical' });
    await expect(row(page, 'alice').locator('.alert-sum')).toHaveText(/Critical only/);
});

test('Add recipient: picked from the chats the bot knows, starts with critical only', async ({ page }) => {
    await openAlerts(page);
    await page.getByRole('button', { name: '+ Add recipient' }).click();
    const add = page.locator('#alert-add-modal');
    await expect(add).toBeVisible();
    await expect(add.locator('#alert-add-confirm')).toBeDisabled();
    // alice and Movie Club are recipients already
    await expect(add.locator('.alert-pick')).toHaveCount(1);
    await add.locator('.alert-pick', { hasText: 'bob' }).click();
    await expect(add.locator('.alert-pick', { hasText: 'bob' })).toHaveAttribute('aria-pressed', 'true');
    await add.locator('#alert-add-confirm').click();
    await expect(add).toBeHidden();
    await expect(row(page, 'bob').locator('.alert-sum')).toHaveText(/Critical only/);
});

test('a rule saves at once and leaves the Settings bar alone', async ({ page }) => {
    const panel = await openAlerts(page);
    const trigger = page.locator('.custom-select:has(#alerts-down-minutes) .custom-select-trigger');
    // Scrolled to first, as a person would: the scroll event of a click's own scrolling closes the list
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await trigger.click();
    await page.locator('.custom-select-panel .custom-select-option', { hasText: '30 minutes' }).click();
    await expect.poll(() => panel.alerts.saves.length).toBe(1);
    expect(panel.alerts.saves[0].rules).toEqual({ downMinutes: 30, sendShare: 'half', repeatHours: 6, fixed: true });
    await expect(page.locator('#settings-bar-text')).toHaveText('No changes');

    await page.locator('#alerts-fixed').click();
    await expect(page.locator('#alerts-fixed')).toHaveAttribute('aria-checked', 'false');
    expect(panel.alerts.saves.at(-1).rules.fixed).toBe(false);
});

test('Remove asks first; a test goes to one person or to everyone', async ({ page }) => {
    const panel = await openAlerts(page);
    await page.getByRole('button', { name: 'Send test to everyone' }).click();
    await expect(page.locator('.toast').last()).toContainText('Test sent to 1, 1 not reached');
    expect(panel.alerts.tests).toEqual([{}]);

    await row(page, 'alice').click();
    await dialog(page).getByRole('button', { name: 'Send test' }).click();
    await expect.poll(() => panel.alerts.tests.length).toBe(2);
    expect(panel.alerts.tests[1]).toEqual({ chatId: '101' });

    await dialog(page).getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#modal-confirm-btn').click();
    await expect(row(page, 'alice')).toHaveCount(0);
    expect(panel.alerts.saves.at(-1)).toEqual({ removed: '101' });
});

test('an older last alert: its date as written, not lower-cased', async ({ page }) => {
    const recipients = [
        {
            chatId: '101',
            name: 'alice',
            type: 'private',
            preset: 'all',
            events: null,
            lastAlertAt: '2026-10-20T10:00:00Z',
            unreachable: null,
            unreachableAt: null
        }
    ];
    await openAlerts(page, { alerts: { recipients } });
    await expect(row(page, 'alice').locator('.alert-meta')).toHaveText('Last alert 20 Oct');
});

test('no recipients yet: says how to start, no test button', async ({ page }) => {
    await mockPanel(page, { alerts: { recipients: [] } });
    await openSection(page, 'settings');
    await expect(page.locator('#alerts-people')).toContainText('No one gets alerts yet');
    await expect(page.locator('#alerts-test-all')).toBeHidden();
});

test('rows and the dialog fit a phone: nothing wider than the screen', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone layout');
    await openAlerts(page);
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    for (const box of await page
        .locator('.alert-person')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right)))
        expect(box).toBeLessThanOrEqual(width);
    await row(page, 'alice').click();
    const right = await dialog(page)
        .locator('.alert-event, .alert-person-foot .btn')
        .evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(width);
});

test('the first answer failed: a dead end, no test button, the rules stay locked', async ({ page }) => {
    await mockPanel(page, { failing: ['/api/alerts'] });
    await openSection(page, 'settings');
    await expect(page.locator('#alerts-people')).toContainText('Failed to load');
    await expect(page.locator('#alerts-log')).toContainText('Failed to load');
    await expect(page.locator('#alerts-test-all')).toBeHidden();
    expect(await page.locator('#alerts-rules').evaluate((el) => /** @type {HTMLElement} */ (el).inert)).toBe(true);
});

test('a placeholder row is as tall as a real one; a long name ends in "…" with its tag in view', async ({ page }) => {
    const long = 'A very long group name that does not fit on one line at all, not even on a wide screen';
    const panel = await openAlerts(page);
    // The next answer (a rule saved) carries the long name
    panel.alerts.recipients[1].name = long;
    await page.locator('#alerts-fixed').click();
    const club = row(page, 'A very long');
    await expect(club).toBeVisible();
    const sizes = await page.evaluate(() => {
        const people = document.querySelector('#alerts-people');
        const real = people.querySelector('.alert-person');
        const skeleton = document.createElement('div');
        skeleton.className = 'alert-person alert-skeleton';
        skeleton.innerHTML =
            '<span class="alert-ava"></span><span class="alert-who"><span class="alert-name"><span class="skeleton"></span></span>' +
            '<span class="alert-meta"><span class="skeleton"></span></span></span>';
        people.append(skeleton);
        const out = [real.getBoundingClientRect().height, skeleton.getBoundingClientRect().height];
        skeleton.remove();
        return out;
    });
    expect(sizes[1]).toBeCloseTo(sizes[0], 0);
    const fit = await club.evaluate((el) => {
        const name = el.querySelector('.alert-name-text');
        const tag = el.querySelector('.alert-tag').getBoundingClientRect();
        const box = el.querySelector('.alert-who').getBoundingClientRect();
        return {
            cut: name.scrollWidth > name.clientWidth,
            ellipsis: getComputedStyle(name).textOverflow,
            tagInside: tag.right <= box.right + 0.5 && tag.width > 0
        };
    });
    expect(fit).toEqual({ cut: true, ellipsis: 'ellipsis', tagInside: true });
});
