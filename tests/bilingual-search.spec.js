const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole } = require('./helpers');
const { mockSearch } = require('./panel-search-fixture');

watchConsole();

async function prepareSearch(page, language, account) {
    await mockPanel(page, { language, role: account ? 'user' : 'admin', path: account ? '/#my-search' : '/#chats' });
    const requests = await mockSearch(page, language);
    if (!account) {
        await page.locator('[data-action="chat-actions"][data-id="101"]').click();
        await page.locator('#action-add').click();
    }
    return {
        input: page.locator(account ? '#mine-q' : '#content-search-input'),
        results: page.locator(account ? '#mine-results' : '#content-search-results'),
        requests
    };
}

for (const account of [true, false]) {
    for (const language of ['ru', 'en']) {
        const label = `${account ? 'personal' : 'admin'} ${language}`;
        test(`${label}: either query language works and secondary names are English only outside English UI`, async ({ page }) => {
            const { input, results, requests } = await prepareSearch(page, language, account);
            for (const query of ['Ричер', 'Reacher']) {
                await input.fill(query);
                await input.press('Enter');
                await expect(results.locator('.search-row')).toHaveCount(1);
                await expect.poll(() => requests.at(-1)?.query).toBe(query);
                expect(requests.at(-1).language).toBe(language);
                await expect(results.locator('.row-name')).toHaveText(language === 'ru' ? 'Джек Ричер' : 'Reacher');
                await expect(results.locator('.search-title-english')).toHaveCount(language === 'ru' ? 1 : 0);
                if (language === 'ru') await expect(results.locator('.search-title-english')).toHaveText('Reacher');
            }
            await input.fill('Рич');
            await input.press('Enter');
            await expect(results.locator('.search-row')).toHaveCount(3);
            if (language === 'ru') {
                const alternate = results.locator('.search-title-english').nth(1);
                await expect(alternate).toHaveText('The Case Files of Jeweler Richard');
                await expect(alternate).toHaveAttribute('lang', 'en');
                expect(await alternate.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(
                    await results.locator('.row-name').nth(1).evaluate(el => parseFloat(getComputedStyle(el).fontSize))
                );
            } else await expect(results.locator('.search-title-english')).toHaveCount(0);
            const layout = await results.evaluate(el => ({
                overflow: el.scrollWidth > el.clientWidth,
                overlap: [...el.querySelectorAll('.search-row')].some(row =>
                    row.querySelector('.search-result-open').getBoundingClientRect().right > row.querySelector('.follow-btn').getBoundingClientRect().left
                )
            }));
            expect(layout).toEqual({ overflow: false, overlap: false });
            await results.locator('.search-result-open').first().click();
            await expect(page.locator(account ? '#mine-card-title' : '#content-card-title')).toHaveText(
                language === 'ru' ? 'Джек Ричер' : 'Reacher'
            );
        });

        test(`${label}: missing and duplicate English names are hidden and catalog markup is escaped`, async ({ page }) => {
            const { input, results } = await prepareSearch(page, language, account);
            await input.fill('edge cases');
            await input.press('Enter');
            await expect(results.locator('.search-row')).toHaveCount(3);
            const alternates = results.locator('.search-title-english');
            await expect(alternates).toHaveCount(language === 'ru' ? 1 : 0);
            if (language === 'ru') await expect(alternates).toHaveText('<img src=x onerror=alert(1)>');
            await expect(results.locator('img[src="x"]')).toHaveCount(0);
        });
    }
}
