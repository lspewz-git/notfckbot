/** Public search payloads for offline bilingual result checks and design captures. */
const samples = [
    { id: 108978, ru: 'Джек Ричер', en: 'Reacher', year: '2022', kind: 'tv' },
    { id: 94523, ru: 'Дела ювелира Ричарда', en: 'The Case Files of Jeweler Richard', year: '2020', kind: 'tv' },
    { id: 98478, ru: 'Большое и Ричард Хаммонд', en: 'Richard Hammond’s Big', year: '2020', kind: 'tv' }
];

function searchFixture(query, language, account = false) {
    const edge = query === 'edge cases';
    const rows = edge ? [
        { id: 1, ru: 'Dune', en: ' dune ', kind: 'movie', year: '2021' },
        { id: 2, ru: 'Без перевода', en: '', kind: 'tv', year: '2020' },
        { id: 3, ru: 'Безопасный текст', en: '<img src=x onerror=alert(1)>', kind: 'tv', year: '2020' }
    ] : samples.filter((r) => `${r.ru} ${r.en}`.toLowerCase().includes(query.toLowerCase()));
    return rows.map((r) => {
        const title = language === 'en' ? r.en || 'No English name' : r.ru;
        const englishTitle = language === 'en' ? 'This secondary name must stay hidden' : r.en;
        return account ? {
            tmdbId: `${r.kind}_${r.id}`, kind: r.kind, title, englishTitle, year: r.year,
            poster: null, overview: '', added: false
        } : {
            id: r.id, media_type: r.kind, title, name: title, englishTitle,
            original_name: '宝石商リチャード氏の謎鑑定', original_language: 'ja',
            release_date: `${r.year}-01-01`, first_air_date: `${r.year}-01-01`, poster_path: null
        };
    });
}

async function mockSearch(page, language) {
    const requests = [];
    await page.route(/\/api\/(?:tmdb\/search|account\/chats\/[^/]+\/search)\?/, async (route) => {
        const url = new URL(route.request().url());
        const query = url.searchParams.get('q');
        requests.push({ query, language: route.request().headers()['x-panel-language'] });
        await route.fulfill({ json: searchFixture(query, language, url.pathname.startsWith('/api/account/')) });
    });
    return requests;
}

module.exports = { searchFixture, mockSearch };
