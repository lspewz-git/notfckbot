const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, openProfilePage, isPhone } = require('./helpers');

watchConsole();

async function following(page, overview = null) {
    const panel = await mockPanel(page, { role: 'user', hasPassword: true });
    Object.assign(panel.account.series[0], { title: '12 12 12', poster: '/poster.png', overview });
    panel.account.series[0].links.push({ kind: 'watch', label: 'Watch on SSPoisk', url: 'https://example.test/watch' });
    await openSection(page, 'my-subs');
    await page.locator('#my-subs-body .title-row').first().click();
    return panel;
}

test('title sheet has a compact header and centered Kinopoisk logo', async ({ page }) => {
    await following(page);
    const card = page.locator('#mine-card-body');
    await expect.poll(() => card.evaluate(el => {
        const sheet = el.getBoundingClientRect();
        const close = el.querySelector('.sheet-close').getBoundingClientRect();
        const poster = el.querySelector('.tc-poster').getBoundingClientRect();
        const link = el.querySelector('.tc-link').getBoundingClientRect();
        const logo = el.querySelector('.kp-logo').getBoundingClientRect();
        const s = getComputedStyle(el.querySelector('.tc-link'));
        return {
            padding: getComputedStyle(el).paddingTop,
            top: Math.round(poster.top - sheet.top - el.clientTop),
            close: [close.width, close.height, Math.round(close.top - sheet.top - el.clientTop), Math.round(sheet.right - el.clientLeft - close.right)],
            link: [link.height, s.borderRadius, s.boxSizing],
            logo: [logo.width, logo.height, Math.round(logo.left - link.left), Math.round(logo.top + logo.height / 2 - link.top - link.height / 2)],
            overflow: el.scrollWidth > el.clientWidth
        };
    })).toEqual({ padding: '8px', top: 16, close: [44, 44, 8, 8], link: [44, '14px', 'border-box'], logo: [20, 20, 13, 0], overflow: false });
    await expect(page.locator('.sheet-grabber')).toHaveCount(0);
});

test('notification choice starts collapsed, saves, updates summary and collapses again', async ({ page }) => {
    const panel = await following(page);
    const card = page.locator('#mine-card-modal');
    const toggle = card.getByRole('button', { name: /Notify me/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card.getByRole('radio')).toHaveCount(0);
    await expect(toggle).toContainText('Every episode');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByRole('group', { name: 'Notify me' })).toBeVisible();
    await expect(card.getByRole('radio')).toHaveCount(3);
    await card.getByText('When the whole season is out', { exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('When the whole season is out');
    await expect.poll(() => panel.account.sent.filter(r => r.method === 'POST' && r.path.endsWith('/series')).length).toBe(1);
    await expect(toggle).toBeEnabled();
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#my-subs-body .title-row').first().click();
    await expect(toggle).toContainText('When the whole season is out');
});

test('selecting the current mode closes options without another save', async ({ page }) => {
    const panel = await following(page);
    const card = page.locator('#mine-card-modal');
    const toggle = card.getByRole('button', { name: /Notify me/ });
    await toggle.click();
    await card.getByText('Every episode', { exact: true }).last().click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel.account.sent.filter(r => r.method === 'POST' && r.path.endsWith('/series'))).toHaveLength(0);
});

test('expanding Notify me grows the frame without squeezing the content', async ({ page }) => {
    await following(page);
    const card = page.locator('#mine-card-body');
    await card.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const frame = () => card.evaluate(el => {
        const box = el.getBoundingClientRect();
        return { top: Math.round(box.top), height: Math.round(box.height), page: scrollY, content: el.scrollTop };
    });
    const before = await frame();
    const toggle = card.getByRole('button', { name: /Notify me/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await frame()).height).toBeGreaterThanOrEqual(before.height);
    expect((await frame()).page).toBe(before.page);
    const first = card.locator('.tc-radio').first();
    await expect(first).toBeInViewport({ ratio: 1 });
    await first.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(frame).toEqual(before);
});

for (const section of ['Following fresh', 'Following after Notify', 'Calendar', 'Released', 'Follow', 'Admin details']) {
    test(`${section}: description expands and collapses without moving the card`, async ({ page, isMobile }) => {
        if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
        const overview = 'A long description with enough words to expand. '.repeat(60);
        let card;
        if (section.startsWith('Following')) {
            await following(page, overview);
            card = page.locator('#mine-card-body');
            if (section === 'Following after Notify') {
                const notify = card.getByRole('button', { name: /Notify me/ });
                await notify.click();
                await notify.click();
            }
        } else {
            const admin = section === 'Follow' || section === 'Admin details';
            const panel = await mockPanel(page, { role: admin ? 'admin' : 'user', overview });
            if (section === 'Calendar') {
                panel.account.calendar.items.forEach(item => { item.overview = overview; });
                await openSection(page, 'my-calendar');
                await page.locator('#my-calendar-body .cal-row').first().click();
                card = page.locator('#mine-card-body');
            } else if (section === 'Released') {
                await openSection(page, 'my-aired');
                await page.locator('#my-aired-series .history-open').first().click();
                card = page.locator('#released-body');
            } else if (section === 'Follow') {
                await openSection(page, 'subs');
                await page.locator('#subs-section [data-action="add-content"]').click();
                await page.locator('#content-search-input').fill('long title');
                await page.locator('#content-search-input').press('Enter');
                await expect(page.locator('#content-search-results .search-result-open')).toHaveCount(2);
                await page.locator('#content-search-results .search-result-open').first().click();
                card = page.locator('#content-card-modal .modal-content');
            } else {
                await openSection(page, 'watchlist');
                await page.locator(isPhone(page) ? '#watchlist-body .compact-title' : '#watchlist-body .title-with-poster .link-text').first().click();
                card = page.locator('#detail-modal .modal-content');
            }
        }
        const more = card.getByRole('button', { name: 'Show more', exact: true });
        await expect(more).toBeVisible();
        await card.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
        const frame = () => card.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), height: Math.round(r.height), page: scrollY };
        });
        const before = await frame();
        await more.click();
        const less = card.getByRole('button', { name: 'Show less', exact: true });
        await expect(less).toHaveAttribute('aria-expanded', 'true');
        if (section === 'Admin details') await expect.poll(frame).toEqual(before);
        else {
            await expect.poll(async () => (await frame()).height).toBeGreaterThanOrEqual(before.height);
            expect((await frame()).page).toBe(before.page);
        }
        await less.click();
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(frame).toEqual(before);
    });
}

test('reopening a static detail card restores its natural height for new content', async ({ page }) => {
    const options = { overview: 'A long description. '.repeat(90) };
    await mockPanel(page, options);
    await openSection(page, 'watchlist');
    const opener = page.locator(isPhone(page) ? '#watchlist-body .compact-title' : '#watchlist-body .title-with-poster .link-text').first();
    await opener.click();
    const card = page.locator('#detail-modal .modal-content');
    await expect(card.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
    await card.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const before = (await card.boundingBox()).height;
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await page.keyboard.press('Escape');
    options.overview = 'A short description.';
    await opener.click();
    await expect(page.locator('#detail-desc')).toHaveText(options.overview);
    await expect.poll(async () => (await card.boundingBox()).height).toBeLessThan(before);
});

test('notification options support the keyboard and reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await following(page);
    const card = page.locator('#mine-card-modal');
    const toggle = card.getByRole('button', { name: /Notify me/ });
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.tc-notify-options')).toHaveCSS('animation-name', 'none');
    await expect(toggle.locator('.icon').last()).toHaveCSS('transition-property', 'none');
    const first = card.getByRole('radio', { name: 'Every episode', exact: true });
    await first.focus();
    await first.press('ArrowDown');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Episode 1 and the whole season');
});

test('a pending save updates the summary when the same title was reopened', async ({ page }) => {
    const panel = await following(page);
    let release;
    panel.account.modeHold = new Promise(resolve => { release = resolve; });
    const card = page.locator('#mine-card-modal');
    const toggle = card.getByRole('button', { name: /Notify me/ });
    try {
        await toggle.click();
        await card.getByText('When the whole season is out', { exact: true }).click();
        await expect(toggle).toBeDisabled();
        await card.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('#my-subs-body .title-row').first().click();
        await expect(toggle).toBeDisabled();
    } finally { release(); }
    await expect(toggle).toBeEnabled();
    await expect(toggle).toContainText('When the whole season is out');
    await toggle.click();
    await expect(card.getByRole('radio', { name: 'When the whole season is out', exact: true })).toBeChecked();
});

for (const overview of [null, '   ', 'A short description.', 'A long description. '.repeat(90)]) {
    test(`description expander reflects actual overflow (${overview === null ? 'missing' : overview.trim().length})`, async ({ page }) => {
        await following(page, overview);
        const card = page.locator('#mine-card-modal');
        const text = card.locator('.tc-overview');
        const more = card.getByRole('button', { name: 'Show more', exact: true });
        if (!overview?.trim()) {
            await expect(text).toHaveCount(0);
            await expect(card.locator('.tc-more')).toHaveCount(0);
        } else if (overview.length < 100) {
            await expect(text.locator('.tc-copy')).toHaveText(overview);
            await expect(more).toBeHidden();
        } else {
            await expect(more).toBeVisible();
            await more.click();
            await expect(text).toHaveClass(/is-open/);
            await card.getByRole('button', { name: 'Show less', exact: true }).click();
            await expect(text).not.toHaveClass(/is-open/);
        }
    });
}

test('actions follow expanded options without covering them at 390 by 844', async ({ page, isMobile }, testInfo) => {
    test.skip(!isMobile, 'One iPhone WebKit run at the requested size');
    await page.setViewportSize({ width: 390, height: 844 });
    await following(page, 'A long description. '.repeat(90));
    const card = page.locator('#mine-card-body');
    const visibleActions = () => card.evaluate(el => {
        const sheet = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('.tc-actions > *')];
        return buttons.every(button => {
            const r = button.getBoundingClientRect();
            return r.top >= sheet.top && r.bottom <= Math.min(sheet.bottom, innerHeight) && button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        });
    });
    await expect.poll(visibleActions).toBe(true);
    expect(await card.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    if (process.env.SHEET_SCREENSHOTS) await card.screenshot({ path: testInfo.outputPath('title-12-12-12.png') });
    await card.getByRole('button', { name: /Notify me/ }).click();
    const options = card.locator('.tc-notify-options');
    await expect.poll(() => card.evaluate(el => {
        const options = el.querySelector('.tc-scroll').getBoundingClientRect();
        const actions = el.querySelector('.tc-actions').getBoundingClientRect();
        const row = el.querySelector('.tc-radio');
        const r = row.getBoundingClientRect();
        return {
            belowOptions: actions.top >= options.bottom,
            optionCanBeTapped: row.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
        };
    })).toEqual({ belowOptions: true, optionCanBeTapped: true });
    await expect(options.getByRole('radio')).toHaveCount(3);
    if (process.env.SHEET_SCREENSHOTS) await card.screenshot({ path: testInfo.outputPath('notify-expanded.png') });
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await card.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(visibleActions).toBe(true);
});

test('Session and Password headers start at the top; Escape and scrim dismiss', async ({ page }) => {
    await mockPanel(page, { role: 'user', hasPassword: true });
    for (const type of ['session', 'password']) {
        await openProfilePage(page, 'my-account');
        if (type === 'session') {
            await page.locator('[data-action="devices-open"]').click();
            await page.locator('[data-action="device-open"]').first().click();
        } else await page.locator('[data-action="password-open"]').click();
        const modal = page.locator(type === 'session' ? '#device-modal' : '#password-sheet');
        await expect(modal).toBeVisible();
        await expect.poll(() => modal.locator('.sheet-content').evaluate(el => {
            const tile = el.querySelector('.row-tile-xl').getBoundingClientRect();
            return { top: Math.round(tile.top - el.getBoundingClientRect().top - el.clientTop), width: tile.width, height: tile.height };
        })).toEqual({ top: 16, width: 48, height: 48 });
        await expect(modal.locator('.sheet-grabber')).toHaveCount(0);
        if (type === 'session') await page.keyboard.press('Escape');
        else await modal.click({ position: { x: 2, y: 2 } });
        await expect(modal).toBeHidden();
    }
});
