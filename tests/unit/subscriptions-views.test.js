/**
 * The screens of "Мои подписки" (src/bot/subscriptions-views.js): what each shows and where its
 * buttons lead. Pure functions: no Telegram or database. Run: npm run test:unit
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const views = require('../../src/bot/subscriptions-views');

const buttons = (view) => view.keyboard.reply_markup.inline_keyboard.map((row) => row.map((b) => b.text));
const callbacks = (view) => view.keyboard.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

const serial = (title, extra = {}) => ({
    kind: 'series',
    id: `tv_${title.length}`,
    title,
    status: 'Returning Series',
    notifyType: 'episode',
    ...extra
});
const movie = (title) => ({ kind: 'movie', id: 7, title, year: 2026, date: '2026-12-01' });

describe('the overview', () => {
    test('serials and waiting films under their own headings; settings, archive and history buttons', () => {
        const view = views.buildOverview({
            active: [serial('Пацаны'), movie('Дюна')],
            archived: [serial('Во все тяжкие', { status: 'Ended' })]
        });
        assert.match(view.text, /^📺 <b>Мои подписки<\/b> · 2/);
        assert.ok(view.text.indexOf('<b>Сериалы</b>') < view.text.indexOf('<b>Фильмы в ожидании</b>'));
        assert.match(view.text, /• Пацаны — 🔔 Каждая серия/);
        assert.match(view.text, /• Дюна \(2026\) — 📅/);
        assert.deepEqual(buttons(view), [
            ['⚙️ Настроить подписки'],
            ['🗄 Завершённые (1)'],
            ['📅 Неделя и месяц', '🗓 Вышло по годам']
        ]);
    });

    test('a long list is cut at 40 lines, pointing to the settings', () => {
        const active = Array.from({ length: 45 }, (_, i) => serial(`Сериал ${i}`));
        const view = views.buildOverview({ active, archived: [] });
        assert.match(view.text, /…и ещё 5 — все есть в настройках/);
    });

    test('titles are escaped', () => {
        const view = views.buildOverview({ active: [serial('A <b> & C')], archived: [] });
        assert.match(view.text, /• A &lt;b&gt; &amp; C/);
    });
});

describe('the lists', () => {
    test('settings: pages of eight, the arrows wrap around, each item opens its card', () => {
        const active = Array.from({ length: 10 }, (_, i) => serial(`Сериал ${i}`, { id: `tv_${i}` }));
        const view = views.buildSettingsView({ active }, 1);
        assert.match(view.text, /Страница 2 из 2/);
        const data = callbacks(view);
        assert.deepEqual(data.slice(0, 2), ['subs_s_tv_8_1', 'subs_s_tv_9_1']);
        assert.ok(data.includes('subs_p_0'), 'back to page 1');
        assert.equal(data.at(-1), 'subs_o');
    });

    test('a page past the end shows the last one', () => {
        const view = views.buildSettingsView({ active: [serial('Пацаны')] }, 5);
        assert.doesNotMatch(view.text, /Страница/);
        assert.equal(callbacks(view)[0], 'subs_s_tv_6_0');
    });

    test('the archive: why the series are there, and cards that come back to the archive', () => {
        const view = views.buildArchiveView({ archived: [serial('Лост', { status: 'Ended', id: 'tv_4607' })] }, 0);
        assert.match(view.text, /Новых серий у этих сериалов не будет/);
        assert.equal(callbacks(view)[0], 'subs_s_tv_4607_a0');
        assert.equal(views.isArchiveLoc('a0'), true);
        assert.equal(views.isArchiveLoc('0'), false);
    });
});

describe('the cards', () => {
    test('a running series: the three modes, the current one ticked; back goes to the list it came from', () => {
        const view = views.buildSeriesCard(
            { tmdb_id: 'tv_1', title: 'Пацаны', status: 'Returning Series' },
            'season',
            'a2'
        );
        assert.deepEqual(buttons(view).slice(0, 3), [
            ['🔔 Каждая серия'],
            ['✅ 📦 Весь сезон'],
            ['🆕 1-я серия + Сезон']
        ]);
        assert.ok(callbacks(view).includes('subs_a_2'));
        assert.ok(callbacks(view).includes('subs_cs_tv_1_a2'));
    });

    test('a finished series: no modes, only removal', () => {
        const view = views.buildSeriesCard({ tmdb_id: 'tv_1', title: 'Лост', status: 'Ended' }, 'episode', '0');
        assert.match(view.text, /новых серий не будет/);
        assert.deepEqual(buttons(view), [['❌ Удалить', '⬅️ К списку']]);
    });

    test('confirmations: yes removes, no returns to the card', () => {
        const unsub = views.buildUnsubscribeConfirm({ title: 'Пацаны', status: 'Ended' }, 'tv_1', '3');
        assert.match(unsub.text, /Если сериал продлят, уведомление не придёт/);
        assert.deepEqual(callbacks(unsub), ['subs_us_tv_1_3', 'subs_s_tv_1_3']);

        const remove = views.buildWatchlistRemoveConfirm(null, 9, 'a0');
        assert.match(remove.text, /Удалить <b>фильм<\/b>/, 'a film already gone still gets a sensible text');
        assert.deepEqual(callbacks(remove), ['subs_um_9_a0', 'subs_m_9_a0']);
    });
});
