const { test, expect } = require('@playwright/test');
const { watchConsole, openSection } = require('./helpers');
const { mockPanel } = require('./mock-panel');

/**
 * The test notification dialog, on the canned API: every alert the bot sends can be tried,
 * a film alert picks a film, and status alerts don't ask for a season and episode.
 */

watchConsole();

const dialog = (page) => page.locator('#test-notify-modal');

/** Chats → alice's menu → Send test notification. */
async function openForAlice(page) {
    await openSection(page, 'chats');
    await page.locator('[data-action="chat-actions"][data-id="101"]').click();
    await page.locator('#action-test-notify').click();
    await expect(dialog(page)).toBeVisible();
}

/** Picks an option of one of the dialog's styled dropdowns by its text. */
async function pick(page, selectId, text) {
    await page.locator(`.custom-select:has(#${selectId}) .custom-select-trigger`).click();
    await page.locator('.custom-select-option', { hasText: text }).click();
}

const send = async (page) => {
    await dialog(page).locator('#send-test-notify-btn').click();
    await expect(page.locator('.toast', { hasText: 'Тестовое уведомление успешно отправлено' })).toBeVisible();
};

test('all seven alerts the bot sends are on the list', async ({ page }) => {
    await mockPanel(page);
    await openForAlice(page);
    const options = await page.locator('#test-notify-mode-select option').allTextContents();
    expect(options.map((o) => o.split(' (')[1].replace(')', ''))).toEqual([
        'New Episode',
        'Season Premiere',
        'Whole Season',
        'Ended',
        'Canceled',
        'Renewed',
        'Film Released'
    ]);
});

test('an episode alert sends the series with its season and episode', async ({ page }) => {
    const panel = await mockPanel(page);
    await openForAlice(page);
    await expect(dialog(page).locator('#test-notify-episode-fields')).toBeVisible();
    await send(page);
    expect(panel.lastTest).toEqual({ chatId: '101', mode: 'episode', seriesId: '1399', season: 2, episode: 5 });
});

test('a status alert needs no season or episode', async ({ page }) => {
    const panel = await mockPanel(page);
    await openForAlice(page);
    await pick(page, 'test-notify-mode-select', 'Сериал завершён');
    await expect(dialog(page).locator('#test-notify-episode-fields')).toBeHidden();
    await send(page);
    expect(panel.lastTest).toEqual({ chatId: '101', mode: 'ended', seriesId: '1399' });
});

test('the film alert switches the picker to films and sends a film', async ({ page }) => {
    const panel = await mockPanel(page);
    await openForAlice(page);
    await pick(page, 'test-notify-mode-select', 'Фильм вышел');

    await expect(dialog(page).locator('#test-title-label')).toHaveText('Film');
    await expect(dialog(page).locator('#tab-test-series-db')).toHaveText('Films on lists');
    await expect(dialog(page).locator('#test-notify-episode-fields')).toBeHidden();
    // One option per film, whichever chats have it
    await expect(page.locator('#test-notify-series-select option')).toHaveCount(6);
    await pick(page, 'test-notify-series-select', 'Hunger Games');
    await send(page);
    expect(panel.lastTest).toEqual({ chatId: '101', mode: 'film', filmId: 'movie_5' });
});

test('back from a film to a series alert, the picker shows series again', async ({ page }) => {
    const panel = await mockPanel(page);
    await openForAlice(page);
    await pick(page, 'test-notify-mode-select', 'Фильм вышел');
    await pick(page, 'test-notify-mode-select', 'Сериал продлили');
    await expect(dialog(page).locator('#test-title-label')).toHaveText('Series');
    await send(page);
    expect(panel.lastTest).toEqual({ chatId: '101', mode: 'renewed', seriesId: '1399' });
});
