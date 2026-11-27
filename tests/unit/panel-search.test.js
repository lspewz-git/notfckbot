const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { setImmediate: nextTurn } = require('node:timers/promises');

let requests;
let answer;
let paths;
const create = axios.create.bind(axios);
mock.method(axios, 'create', (options) =>
    create({
        ...options,
        adapter: async (config) => {
            requests.push({ query: config.params?.query, language: config.params?.language, timeout: config.timeout });
            paths.push(config.url);
            const rows = await answer(config.params?.language, config.url);
            return {
                data: config.url.endsWith('/translations') ? { translations: rows } : { results: rows },
                status: 200,
                headers: {},
                config
            };
        }
    })
);
const { searchPanel, searchMulti } = require('../../src/api/tmdb');

beforeEach(() => {
    requests = [];
    paths = [];
    answer = () => [];
});

test('localized search joins English names by media kind and id without replacing selected-language copy', async () => {
    const local = [
        {
            id: 1,
            media_type: 'tv',
            name: 'Дела ювелира Ричарда',
            original_name: '宝石商リチャード氏の謎鑑定',
            original_language: 'ja'
        },
        { id: 1, media_type: 'movie', title: 'Дюна', original_language: 'en', original_title: 'Dune' }
    ];
    answer = (language) =>
        language === 'ru-RU'
            ? local
            : [
                  { id: 1, media_type: 'movie', title: 'Dune' },
                  { id: 1, media_type: 'tv', name: 'The Case Files of Jeweler Richard' }
              ];
    const results = await searchPanel('Ричард', 'ru-RU');
    assert.deepEqual(
        results.map((r) => r.englishTitle),
        ['The Case Files of Jeweler Richard', 'Dune']
    );
    assert.equal(results[0].name, local[0].name);
    assert.equal(local[0].englishTitle, undefined, 'the raw catalog response is not changed');
    assert.deepEqual(
        requests.map((r) => r.query),
        ['Ричард', 'Ричард']
    );
    assert.ok(requests.every((r) => r.timeout === 5000));
});

for (const query of ['Ричер', 'Reacher']) {
    test(`English UI forwards ${query} unchanged with one English request and no secondary name`, async () => {
        answer = () => [{ id: 2, media_type: 'tv', name: 'Reacher' }];
        assert.equal((await searchPanel(query, 'en-US'))[0].name, 'Reacher');
        assert.deepEqual(requests, [{ query, language: 'en-US', timeout: 5000 }]);
    });
}

test('an unavailable English search preserves localized results and only uses verified English originals', async () => {
    answer = (language) => {
        if (language === 'en-US') throw new Error('English catalog unavailable');
        return [
            {
                id: 3,
                media_type: 'tv',
                name: 'Русское название',
                original_language: 'ja',
                original_name: 'Japanese original'
            },
            { id: 4, media_type: 'tv', name: 'Джек Ричер', original_language: 'en', original_name: 'Reacher' }
        ];
    };
    assert.deepEqual(
        (await searchPanel('Ричер', 'ru-RU')).map((r) => r.englishTitle),
        ['', 'Reacher']
    );
});

test('English rows missing from the extra search never become another non-English original', async () => {
    answer = (language) =>
        language === 'en-US'
            ? []
            : [{ id: 5, media_type: 'movie', title: 'Перевод', original_language: 'ja', original_title: '原作' }];
    assert.equal((await searchPanel('Перевод', 'ru-RU'))[0].englishTitle, '');
});

test('a selected-language search error remains a search error', async () => {
    answer = (language) => {
        if (language === 'ru-RU') throw new Error('Selected catalog unavailable');
        return [];
    };
    await assert.rejects(searchPanel('Ричер', 'ru-RU'), /Selected catalog unavailable/);
});

test('a title missing from the English search page still gets its available English translation by id', async () => {
    answer = (language, url) => {
        if (url.endsWith('/translations'))
            return [{ iso_639_1: 'en', iso_3166_1: 'US', data: { name: 'English translation' } }];
        return language === 'en-US'
            ? []
            : [{ id: 8101, media_type: 'tv', name: 'Русский перевод', original_language: 'ja', original_name: '原作' }];
    };
    assert.equal((await searchPanel('Название', 'ru-RU'))[0].englishTitle, 'English translation');
    assert.ok(paths.includes('/tv/8101/translations'));
});

test('an English search fallback to a foreign original is not labelled English, while a verified same-name translation is allowed', async () => {
    answer = (language, url) => {
        if (url === '/tv/8102/translations') return [{ iso_639_1: 'ja', data: { name: '原作' } }];
        if (url === '/movie/8103/translations')
            return [{ iso_639_1: 'en', iso_3166_1: 'GB', data: { title: 'Amélie' } }];
        return [
            {
                id: 8102,
                media_type: 'tv',
                name: language === 'en-US' ? '原作' : 'Русское название',
                original_language: 'ja',
                original_name: '原作'
            },
            {
                id: 8103,
                media_type: 'movie',
                title: language === 'en-US' ? 'Amélie' : 'Амели',
                original_language: 'fr',
                original_title: 'Amélie'
            }
        ];
    };
    assert.deepEqual(
        (await searchPanel('Название', 'ru-RU')).map((r) => r.englishTitle),
        ['', 'Amélie']
    );
});

test('bot search keeps its original language, timeout and result shape', async () => {
    answer = () => [
        { id: 6, media_type: 'tv', name: 'Сериал' },
        { id: 7, media_type: 'person' }
    ];
    assert.deepEqual(await searchMulti('Сериал'), [{ id: 6, media_type: 'tv', name: 'Сериал' }]);
    assert.deepEqual(requests, [{ query: 'Сериал', language: 'ru-RU', timeout: 15000 }]);
});

test('verified translations prefer US English and reuse fresh and stale cached names', async () => {
    answer = (language, url) => {
        if (url.endsWith('/translations'))
            return [
                { iso_639_1: 'en', iso_3166_1: 'GB', data: { title: 'British name' } },
                { iso_639_1: 'en', iso_3166_1: 'US', data: { title: 'US name' } }
            ];
        return language === 'en-US'
            ? []
            : [{ id: 8104, media_type: 'movie', title: 'Перевод', original_language: 'fr' }];
    };
    assert.equal((await searchPanel('Перевод', 'ru-RU'))[0].englishTitle, 'US name');
    assert.equal((await searchPanel('Перевод', 'ru-RU'))[0].englishTitle, 'US name');
    assert.equal(paths.filter((p) => p.endsWith('/translations')).length, 1);
    const previous = answer;
    answer = (language, url) => {
        if (url.endsWith('/translations')) throw new Error('Catalog unavailable');
        return previous(language, url);
    };
    const now = Date.now;
    try {
        Date.now = () => now() + 7 * 3600e3;
        assert.equal((await searchPanel('Перевод', 'ru-RU'))[0].englishTitle, 'US name');
    } finally {
        Date.now = now;
    }
});

test('exceptional translation lookups use at most four concurrent workers', async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let active = 0;
    let maximum = 0;
    answer = async (language, url) => {
        if (url.endsWith('/translations')) {
            active++;
            maximum = Math.max(maximum, active);
            await gate;
            active--;
            return [{ iso_639_1: 'en', data: { name: 'English title' } }];
        }
        return language === 'en-US'
            ? []
            : Array.from({ length: 10 }, (_, i) => ({
                  id: 8200 + i,
                  media_type: 'tv',
                  name: 'Перевод',
                  original_language: 'ja'
              }));
    };
    const pending = searchPanel('Перевод', 'ru-RU');
    for (let i = 0; i < 10 && active < 4; i++) await nextTurn();
    const before = active;
    release();
    const rows = await pending;
    assert.equal(before, 4);
    assert.equal(maximum, 4);
    assert.ok(rows.every((r) => r.englishTitle === 'English title'));
});
