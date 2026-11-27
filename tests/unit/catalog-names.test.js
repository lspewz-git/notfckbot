const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPanelLocalizer } = require('../../src/admin/catalog-names');
const request = (language) => ({ get: () => language });

test('page payload names resolve together, coalesce by locale and never mutate source data or chat names', async () => {
    const calls = [];
    const localize = createPanelLocalizer(async (id, kind, language) => {
        calls.push([id, kind, language]);
        return { title: `${language}:${kind}:${id}` };
    });
    const original = {
        series: [{ id: 'tv_100', title: 'Stored' }],
        items: [{ tmdbId: 'tv_100', title: 'Stored' }],
        films: [{ tmdb_id: 'movie_7', title: 'Film', Chat: { id: 'tv_100', title: 'A chat' } }],
        subs: [{ seriesId: '100', Series: { title: 'Stored' } }]
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    const [en, concurrent] = await Promise.all([localize(request('en'), original), localize(request('en'), original)]);
    assert.equal(en.series[0].title, 'en-US:tv:100');
    assert.equal(en.items[0].title, en.subs[0].Series.title);
    assert.equal(en.films[0].title, 'en-US:movie:7');
    assert.equal(en.films[0].Chat.title, 'A chat');
    assert.deepEqual(en, concurrent);
    assert.deepEqual(original, snapshot);
    assert.equal(calls.length, 2);
    assert.equal((await localize(request('ru'), original)).series[0].title, 'ru-RU:tv:100');
    assert.equal(calls.length, 4);
    await localize(request('en'), original);
    assert.equal(calls.length, 4);
});

test('card names resolve before the response and empty or failed catalog copy preserves stored names', async () => {
    const localize = createPanelLocalizer(async (id) => {
        if (id === '2') throw new Error('Offline');
        return { title: id === '1' ? 'Localized' : '' };
    });
    assert.equal((await localize(request('en'), { name: 'Stored' }, 'tv_1')).name, 'Localized');
    assert.deepEqual(
        await localize(request('en'), [
            { tmdb_id: 'movie_2', title: 'Stored film' },
            { id: 'tv_3', title: 'Stored series' },
            { id: '123', title: 'A person' }
        ]),
        [
            { tmdb_id: 'movie_2', title: 'Stored film' },
            { id: 'tv_3', title: 'Stored series' },
            { id: '123', title: 'A person' }
        ]
    );
});

test('a slow catalog has a response-wide budget, bounded workers and no late payload mutation', async () => {
    let release;
    let active = 0;
    let peak = 0;
    let calls = 0;
    const gate = new Promise((resolve) => (release = resolve));
    const localize = createPanelLocalizer(async () => {
        calls++;
        peak = Math.max(peak, ++active);
        await gate;
        active--;
        return { title: 'Late title' };
    }, 25);
    const original = Array.from({ length: 12 }, (_, i) => ({ id: `tv_${i + 1}`, title: `Stored ${i}` }));
    const result = await localize(request('en'), original);
    assert.deepEqual(result, original);
    assert.equal(peak, 4);
    assert.equal(calls, 4);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(result, original, 'a settled response is immutable even after late success');
    assert.equal(calls, 4, 'the expired budget stops queued work');
});

for (const outcome of ['slow', 'empty']) {
    test(`expired translations survive a ${outcome} refresh within the page budget`, async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        let expired = false;
        const localize = createPanelLocalizer(async () => {
            if (!expired) return { title: 'Known translation' };
            if (outcome === 'slow') await gate;
            return { title: '' };
        }, 20);
        const payload = [{ id: 'tv_800001', title: 'Stored name' }];
        await localize(request('en'), payload);
        const realNow = Date.now;
        Date.now = () => realNow() + 21600001;
        expired = true;
        try {
            const result = await localize(request('en'), payload);
            assert.equal(result[0].title, 'Known translation');
            assert.equal(
                (await localize(request('en'), payload))[0].title,
                'Known translation',
                'an empty refresh must preserve the translation for the next opening too'
            );
        } finally {
            Date.now = realNow;
            release();
        }
    });
}

test('cached names after slow cold entries remain available without waiting for their worker', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const localize = createPanelLocalizer(async (id) => {
        if (id !== '900005') await gate;
        return { title: 'Known translation' };
    }, 20);
    await localize(request('en'), [{ id: 'tv_900005', title: 'Stored' }]);
    try {
        const payload = Array.from({ length: 5 }, (_, index) => ({ id: `tv_${900001 + index}`, title: 'Stored' }));
        const result = await localize(request('en'), payload);
        assert.equal(result[4].title, 'Known translation');
    } finally {
        release();
    }
});

test('legacy upcoming ids use the explicit media kind while person ids stay untouched', async () => {
    const calls = [];
    const localize = createPanelLocalizer(async (id, kind) => {
        calls.push([id, kind]);
        return { title: `${kind}:${id}` };
    });
    const result = await localize(request('en'), [
        { kind: 'tv', id: '66732', title: 'Stored' },
        { kind: 'movie', id: '7', title: 'Film' },
        { id: '42', title: 'Person' }
    ]);
    assert.deepEqual(
        result.map((row) => row.title),
        ['tv:66732', 'movie:7', 'Person']
    );
    assert.deepEqual(calls, [
        ['66732', 'tv'],
        ['7', 'movie']
    ]);
});
