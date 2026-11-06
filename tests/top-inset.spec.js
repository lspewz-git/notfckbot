// Screens' first rows start 12px under the content's top plus the system inset (--top-inset, base.css):
// 0 in a browser tab and Telegram's normal mode, the device's or Telegram's safe areas in fullscreen
const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole } = require('./helpers');

watchConsole();

const SCREENS = ['my-calendar', 'my-aired', 'my-subs', 'my-profile', 'my-account', 'my-settings', 'my-devices', 'my-search'];
const rowOf = (id) => (id === 'my-search' ? '#my-search-section .search-bar' : `#${id}-section > header`);

async function tops(context, insets = null) {
    const out = {};
    for (const id of SCREENS) {
        const page = await context.newPage();
        if (insets) {
            // The native bridge answers the safe area requests the way Telegram does (tg-back.js)
            await page.addInitScript((tg) => {
                window.TelegramWebviewProxy = {
                    postEvent(event) {
                        const send = (name, top) =>
                            setTimeout(() =>
                                window.Telegram.WebView.receiveEvent(name, { top, bottom: 0, left: 0, right: 0 })
                            );
                        if (event === 'web_app_request_safe_area') send('safe_area_changed', tg.safe);
                        if (event === 'web_app_request_content_safe_area') send('content_safe_area_changed', tg.content);
                    }
                };
            }, insets);
        }
        await mockPanel(page, { role: 'user', path: `/#${id}` });
        const row = page.locator(rowOf(id));
        await expect(row).toBeVisible();
        out[id] = await row.evaluate((el) => Math.round(el.getBoundingClientRect().top));
        await page.close();
    }
    return out;
}

const every = (value) => Object.fromEntries(SCREENS.map((id) => [id, value]));

test('in a browser tab every screen title row starts 12px from the top', async ({ context }) => {
    test.setTimeout(90000);
    expect(await tops(context)).toEqual(every(12));
});

test("Telegram's fullscreen safe areas push the title rows under its status bar and buttons", async ({
    context
}) => {
    test.setTimeout(90000);
    expect(await tops(context, { safe: 47, content: 46 })).toEqual(every(12 + 47 + 46));
});

test("Telegram's normal mode adds nothing", async ({ context }) => {
    test.setTimeout(90000);
    expect(await tops(context, { safe: 0, content: 0 })).toEqual(every(12));
});
