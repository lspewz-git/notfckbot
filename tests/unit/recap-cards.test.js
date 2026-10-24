/**
 * The recap cards kept on disk and the pictures they can be drawn on (src/recap/store.js,
 * backgrounds.js, render.js, the drawing thread, src/admin/routes/recap-cards.js). The disk is a
 * temporary folder, the database and the chat's figures are stand-ins; the drawing is real.
 * Run: npm run test:unit
 */
const { test, describe, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cacache = require('cacache');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-'));
process.env.RECAP_CARDS_DIR = path.join(DIR, 'cards');
process.env.RECAP_BACKGROUNDS_DIR = path.join(DIR, 'backgrounds');

// The figures and the database, before render.js takes its references
const chatStats = require('../../src/chat-stats');
const pool = require('../../src/recap/pool');
const { Chat, RecapLook, Subscription, Watchlist } = require('../../src/db');

const STATS = {
    period: { from: '2026-01-01', to: '2026-12-31' },
    following: { series: 2, running: 1, films: 1 },
    episodes: { count: 10, minutes: 600, series: 2, seasons: 2, byMonth: [], top: [] },
    films: { released: [], minutes: 0, longestWait: null },
    favourites: { genres: [], networks: [], countries: [] },
    best: [],
    finished: [],
    ahead: { series: 0, films: 0, next: [] },
    rare: []
};
let stats = STATS;
// A chat's own figures when a test gives it some
let statsOf = {};
mock.method(chatStats, 'loadChatStats', async (id) => statsOf[id] || stats);
const drawn = [];
const realDraw = pool.draw;
mock.method(pool, 'draw', async (task) => {
    drawn.push(task.kind);
    return realDraw(task);
});

// RecapLook in memory
let looks = [];
mock.method(RecapLook, 'findAll', async () => looks.map((l) => ({ ...l })));
mock.method(RecapLook, 'upsert', async (row) => {
    looks = looks.filter((l) => l.card !== row.card).concat(row);
});
mock.method(RecapLook, 'update', async (changes, { where }) => {
    for (const l of looks) if (l.background === where.background) Object.assign(l, changes);
});
mock.method(Chat, 'findByPk', async (id) => ({ id: Number(id), username: 'club', type: 'group' }));
// The best title's poster: null as TMDB not answering
let poster = null;
mock.method(require('../../src/admin/posters'), 'posterBytes', async () => poster);

const store = require('../../src/recap/store');
const backgrounds = require('../../src/recap/backgrounds');
const render = require('../../src/recap/render');

after(async () => {
    await pool.closePool();
    fs.rmSync(DIR, { recursive: true, force: true });
});
afterEach(() => {
    drawn.length = 0;
    stats = STATS;
    statsOf = {};
    poster = null;
    render.forgetRecap();
});

/** A real PNG of a plain colour, w x h, drawn the way a card is. */
const plainPng = (w, h, colour = '#335577') =>
    pool.draw({
        kind: 'card',
        element: { type: 'div', props: { style: { display: 'flex', width: w, height: h, background: colour } } }
    });

const sizeOf = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

describe('the drawing thread', () => {
    test('an upload is cropped to a card, 1080x1350; a small copy is 120 wide', async () => {
        const fitted = await pool.draw({ kind: 'fit', bytes: await plainPng(1080, 1350) });
        assert.deepEqual(sizeOf(fitted), { width: 1080, height: 1350 });
        assert.equal(sizeOf(await pool.draw({ kind: 'thumb', png: fitted })).width, 120);
    });

    test("a phone photo's EXIF turn is read, in either byte order; none means as stored", () => {
        const { orientationOf } = require('../../src/recap/worker');
        /** SOI, an APP1 Exif with Orientation = value, then the picture data (SOS). */
        const jpeg = (value, little) => {
            const u16 = (n) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
            const u32 = (n) => (little ? [n, 0, 0, 0] : [0, 0, 0, n]);
            const tiff = [...(little ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a]), ...u32(8), ...u16(1)];
            const entry = [...u16(0x0112), ...u16(3), ...u32(1), ...u16(value), 0, 0, 0, 0, 0, 0];
            const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from([...tiff, ...entry])]);
            const length = body.length + 2;
            return Buffer.concat([
                Buffer.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff]),
                body,
                Buffer.from([0xff, 0xda, 0, 2])
            ]);
        };
        assert.equal(orientationOf(jpeg(6, false)), 6);
        assert.equal(orientationOf(jpeg(8, true)), 8);
        assert.equal(orientationOf(jpeg(42, true)), 1);
        assert.equal(orientationOf(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
    });

    test('a turned photo: its upright frame is the one fitted, the picture turned inside it', () => {
        const { uprightSvg } = require('../../src/recap/worker');
        const svg = uprightSvg('data:x', { width: 4000, height: 3000 }, 6);
        assert.match(svg, /viewBox="0 0 3000 4000"/);
        assert.match(svg, /width="4000" height="3000" transform="matrix\(0 1 -1 0 3000 0\)"/);
        assert.doesNotMatch(uprightSvg('data:x', { width: 40, height: 30 }, 1), /transform/);
    });

    test('a picture of more than 25 megapixels is refused before it is unpacked', async () => {
        const huge = await plainPng(10, 10);
        huge.writeUInt32BE(20000, 16);
        huge.writeUInt32BE(20000, 20);
        await assert.rejects(pool.draw({ kind: 'fit', bytes: huge }), /Too big: 20000 × 20000/);
    });

    test('anything but a PNG or JPEG is refused, and so is one that draws nothing', async () => {
        await assert.rejects(pool.draw({ kind: 'fit', bytes: Buffer.from('GIF89a…') }), /Not a PNG or JPEG/);
        // A real header, then noise
        const broken = await plainPng(10, 10);
        broken.fill(7, 40);
        await assert.rejects(pool.draw({ kind: 'fit', bytes: broken }), /could not be read/);
    });
});

describe('the cards on disk', () => {
    test('a set is drawn once; the next look reads it from the disk, even after the memory forgot it', async () => {
        const first = await render.recapImages('-100', 2026);
        assert.equal(first.images.length, 6);
        assert.deepEqual(
            drawn.filter((k) => k === 'card'),
            Array(6).fill('card')
        );
        assert.equal(drawn.filter((k) => k === 'thumb').length, 6);

        drawn.length = 0;
        render.forgetRecap();
        const again = await render.recapImages('-100', 2026);
        assert.deepEqual(drawn, [], 'nothing drawn');
        assert.ok(again.images[0].equals(first.images[0]));
        const [set] = await store.listSets(2026);
        assert.equal(set.chatId, '-100');
        assert.ok(set.bytes > 0);
        assert.ok(await store.readThumb('-100', 2026, 3));
    });

    test('new figures: the kept set no longer matches and is drawn again', async () => {
        await render.recapImages('-101', 2026);
        const before = (await render.recapInputs('-101', 2026)).hash;
        stats = { ...STATS, episodes: { ...STATS.episodes, count: 11 } };
        render.forgetRecap();
        drawn.length = 0;
        const inputs = await render.recapInputs('-101', 2026);
        assert.notEqual(inputs.hash, before);
        assert.equal(await store.readSet('-101', 2026, inputs.hash), null);
        await render.recapImages('-101', 2026);
        assert.equal(drawn.filter((k) => k === 'card').length, 6);
    });

    test('using the bot or a notification does not make a kept set look out of date', async () => {
        const before = (await render.recapInputs('-104', 2026)).hash;
        stats = {
            ...STATS,
            usage: { total: 9, features: [] },
            members: { added: [], used: [{ name: '@a', n: 9 }] },
            notifications: { total: 3 }
        };
        assert.equal((await render.recapInputs('-104', 2026)).hash, before);
    });

    test('the fingerprint covers every part of the figures the cards read', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../src/recap/cards.js'), 'utf8');
        const read = new Set([...source.matchAll(/\bstats\.([a-zA-Z]+)/g)].map((m) => m[1]));
        read.delete('js'); // "src/chat-stats.js" in a comment
        // And what is taken apart: const { episodes, films } = stats
        for (const m of source.matchAll(/\{([^{}]*)\}\s*=\s*stats\s*[;,)]/g)) {
            for (const name of m[1].split(',')) read.add(name.split(':')[0].trim());
        }
        for (const field of read) assert.ok(render.CARD_FIELDS.includes(field), `cards.js reads stats.${field}`);
    });

    test('a set cut short (its cards of another drawing) is no match', async () => {
        const images = await Promise.all([1, 2, 3, 4, 5, 6].map(() => plainPng(10, 10)));
        await store.writeSet('-102', 2026, 'old', images, images);
        // The first card overwritten by a later drawing that never finished
        await cacache.put(process.env.RECAP_CARDS_DIR, 'card:2026:-102:1', images[0], {
            metadata: { hash: 'new' }
        });
        assert.equal(await store.readSet('-102', 2026, 'old'), null);
    });

    test('removing a set: gone from the list, its files freed', async () => {
        await render.recapImages('-103', 2026);
        await store.removeSet('-103', 2026);
        assert.ok(!(await store.listSets(2026)).some((s) => s.chatId === '-103'));
        assert.equal(await store.readThumb('-103', 2026, 1), null);
    });
});

describe('the cards on disk, when things go wrong', () => {
    const CONTENT = () => path.join(process.env.RECAP_CARDS_DIR, 'content-v2');
    const files = (dir) =>
        fs.existsSync(dir)
            ? fs
                  .readdirSync(dir, { withFileTypes: true })
                  .flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : [d.name]))
            : [];

    test('a poster TMDB did not give: the cards are drawn without it and not kept as if they had it', async () => {
        statsOf = {
            '-110': { ...STATS, best: [{ title: 'Show', rating: 8, kind: 'series', poster_url: 'https://x/p.jpg' }] }
        };
        const drawn1 = await render.recapImages('-110', 2026);
        assert.equal(drawn1.images.length, 6);
        assert.ok(!(await store.listSets(2026)).some((s) => s.chatId === '-110'));
    });

    test('a set drawn again replaces the old files instead of piling up', async () => {
        // Figures of its own: its files are shared with no other chat's
        statsOf = { '-111': { ...STATS, episodes: { ...STATS.episodes, count: 41 } } };
        await render.recapImages('-111', 2026);
        statsOf = { '-111': { ...STATS, episodes: { ...STATS.episodes, count: 42 } } };
        render.forgetRecap();
        await render.recapImages('-111', 2026);
        // Every file on the disk is one an entry points to: nothing of the old set is left over
        const live = new Set(Object.values(await cacache.ls(process.env.RECAP_CARDS_DIR)).map((e) => e.integrity));
        assert.equal(files(CONTENT()).length, live.size);
    });

    test('a removal while another chat is written loses nothing of the other', async () => {
        await render.recapImages('-112', 2026);
        const images = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => plainPng(8, 8 + n)));
        await Promise.all([
            store.writeSet('-113', 2026, 'h', images, images),
            store.removeSet('-112', 2026),
            store.writeSet('-114', 2026, 'h', images, images)
        ]);
        assert.equal((await store.readSet('-113', 2026, 'h')).length, 6);
        assert.equal((await store.readSet('-114', 2026, 'h')).length, 6);
        assert.ok(!(await store.listSets(2026)).some((s) => s.chatId === '-112'));
    });

    test('files deleted while the cards were being drawn: the drawing keeps its cards to itself', async () => {
        const drawing = render.drawRecap('-115', 2026);
        // A deletion asked meanwhile (the panel's Delete, a background changed)
        render.forgetRecap('-115', 2026);
        assert.equal((await drawing).images.length, 6);
        assert.ok(!(await store.listSets(2026)).some((s) => s.chatId === '-115'));
    });

    test('two asks for one chat at once make one drawing', async () => {
        drawn.length = 0;
        const [a, b] = await Promise.all([render.drawRecap('-116', 2026), render.drawRecap('-116', 2026)]);
        assert.equal(a, b);
        assert.equal(drawn.filter((k) => k === 'card').length, 6);
    });
});

describe('backgrounds', () => {
    test('uploaded, listed, put on a card (which changes the fingerprint), removed (back to the colour)', async () => {
        const plain = await render.recapInputs('-104', 2026);
        const picture = await backgrounds.addBackground('Sunset <1>.png', await plainPng(800, 600, '#f5b14c'));
        assert.equal(picture.name, 'Sunset 1.png');
        assert.deepEqual(sizeOf(await backgrounds.backgroundBytes(picture.id)), { width: 1080, height: 1350 });
        assert.equal(sizeOf(await backgrounds.backgroundBytes(picture.id, { thumb: true })).width, 240);

        await backgrounds.setCardLook(3, { background: picture.id, dim: 120 });
        assert.deepEqual((await backgrounds.cardLooks())[2], { card: 3, background: picture.id, dim: 80 });
        assert.deepEqual((await backgrounds.listBackgrounds())[0].cards, [3]);
        assert.notEqual((await render.recapInputs('-104', 2026)).hash, plain.hash);

        // Drawn on it: the card's PNG differs from the plain one
        const onPicture = await render.previewCard('-104', 2026, 3, { background: picture.id, dim: 0 });
        const asColour = await render.previewCard('-104', 2026, 3, { background: null, dim: 0 });
        assert.ok(!onPicture.equals(asColour));

        assert.equal(await backgrounds.removeBackground(picture.id), true);
        assert.deepEqual((await backgrounds.cardLooks())[2], { card: 3, background: null, dim: 0 });
        assert.equal(await backgrounds.backgroundBytes(picture.id), null);
        assert.equal(await backgrounds.removeBackground(picture.id), false);
    });

    test('a card set to a picture that is not there is refused; a made-up id never reaches the disk', async () => {
        await assert.rejects(backgrounds.setCardLook(1, { background: 'abcdefabcdefabcd' }), /No such picture/);
        assert.equal(await backgrounds.backgroundBytes('../../etc/passwd'), null);
    });
});

describe('the API', () => {
    let base;
    let server;
    before(async () => {
        const app = express();
        app.use(express.json());
        app.use(require('../../src/admin/routes/recap-cards'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    const uploadFile = (bytes, type = 'image/png', name = 'pic.png') => {
        const form = new FormData();
        form.append('picture', new Blob([bytes], { type }), name);
        return fetch(`${base}/api/recap/backgrounds`, { method: 'POST', body: form });
    };
    const put = (card, body) =>
        fetch(`${base}/api/recap/looks/${card}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

    test('an upload: a picture is taken; too big, another type or not a picture at all is refused', async () => {
        const ok = await uploadFile(await plainPng(300, 300));
        assert.equal(ok.status, 201);
        const { id } = await ok.json();
        mock.method(Subscription, 'findOne', async () => null);
        const listed = await (await fetch(`${base}/api/recap/looks?year=2026`)).json();
        assert.ok(listed.pictures.some((p) => p.id === id));
        assert.equal(listed.cards.length, 6);

        const big = await uploadFile(Buffer.alloc(5 * 1024 * 1024 + 1));
        assert.equal(big.status, 400);
        assert.match((await big.json()).error, /5 MB/);
        assert.equal((await uploadFile(Buffer.from('gif'), 'image/gif', 'a.gif')).status, 400);
        const fake = await uploadFile(Buffer.from('not a picture'));
        assert.equal(fake.status, 400);
        assert.match((await fake.json()).error, /Not a PNG or JPEG/);
    });

    test('a card look: a card 1 to 6, a dim up to 80%, a picture that is there', async () => {
        assert.equal((await put(7, { background: null })).status, 400);
        assert.equal((await put(1, { background: null, dim: 90 })).status, 400);
        assert.equal((await put(1, { background: '../x' })).status, 400);
        assert.equal((await put(1, { background: 'abcdefabcdefabcd' })).status, 404);
        const cleared = await put(1, { background: null });
        assert.equal(cleared.status, 200);
        assert.equal((await cleared.json()).cards[0].background, null);
    });

    test('ready cards: drawn, out of date, not drawn; a bad year is refused', async () => {
        mock.method(Chat, 'findAll', async () => [
            { id: -100, username: 'drawn', type: 'group' },
            { id: -101, username: 'changed', type: 'group' },
            { id: -105, username: 'never', type: 'private' }
        ]);
        mock.method(Subscription, 'findAll', async () => [{ chatId: -100 }, { chatId: -101 }, { chatId: -105 }]);
        mock.method(Watchlist, 'findAll', async () => []);
        await render.recapImages('-100', 2026);
        await render.recapImages('-101', 2026);
        statsOf = { '-101': { ...STATS, episodes: { ...STATS.episodes, count: 99 } } };

        const answer = await (await fetch(`${base}/api/recap/ready?year=2026`)).json();
        const state = Object.fromEntries(answer.chats.map((c) => [c.name, c.state]));
        assert.deepEqual(state, { drawn: 'ready', changed: 'old', never: 'none' });
        assert.equal((await fetch(`${base}/api/recap/ready?year=abc`)).status, 400);
    });
});
