/**
 * Posters on the server's disk (src/admin/posters.js): fetched from TMDB once, then served from
 * disk; a failed or broken download stores nothing; the sweep drops what nobody opened for
 * months. TMDB is stubbed, the cache is a temporary folder. Run: npm run test:unit
 */
const { test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const axios = require('axios');
const express = require('express');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'posters-'));
process.env.POSTER_CACHE_DIR = DIR;
const { servePoster, posterBytes, sweepPosters, MAX_AGE_DAYS } = require('../../src/admin/posters');

const IMAGE = Buffer.from('a poster, byte by byte');
let upstream; // () => what axios.get resolves or throws
let asked;
mock.method(axios, 'get', async () => {
    asked += 1;
    return upstream();
});
const JPEG = { 'content-type': 'image/jpeg' };
const ok = () => ({ headers: JPEG, data: Readable.from([IMAGE.subarray(0, 8), IMAGE.subarray(8)]) });

let server;
let base;
before(async () => {
    const app = express();
    app.get('/api/poster/:size/:file', (req, res) => servePoster(req.params.size, req.params.file, res));
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api/poster`;
});
after(() => {
    server.close();
    fs.rmSync(DIR, { recursive: true, force: true });
});
beforeEach(() => {
    asked = 0;
    upstream = ok;
});

const stored = (size, file) => path.join(DIR, size, file);
/** The copy is renamed into place once the download ends: wait for it (or for its absence). */
const settle = () => new Promise((r) => setTimeout(r, 100));
const leftovers = (size) => (fs.existsSync(path.join(DIR, size)) ? fs.readdirSync(path.join(DIR, size)) : []);

test('the first request fetches from TMDB and keeps the poster; the next one is served from disk', async () => {
    const first = await fetch(`${base}/w342/abc.jpg`);
    assert.equal(first.status, 200);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), IMAGE);
    await settle();
    assert.deepEqual(fs.readFileSync(stored('w342', 'abc.jpg')), IMAGE);

    upstream = () => {
        throw new Error('TMDB must not be asked again');
    };
    const second = await fetch(`${base}/w342/abc.jpg`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('content-type'), 'image/jpeg');
    assert.match(second.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), IMAGE);
    assert.equal(asked, 1);
});

test('TMDB answering with an error: the same status, nothing stored, not marked cacheable', async () => {
    upstream = () => {
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
    };
    const res = await fetch(`${base}/w185/missing.jpg`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), null);
    await settle();
    assert.deepEqual(leftovers('w185'), []);
    // Asked again next time: a failure isn't remembered
    upstream = ok;
    assert.equal((await fetch(`${base}/w185/missing.jpg`)).status, 200);
    assert.equal(asked, 2);
});

test('a download cut off halfway leaves no file behind, so half an image is never served', async () => {
    upstream = () => ({
        headers: JPEG,
        data: new Readable({
            read() {
                this.push(IMAGE.subarray(0, 5));
                this.destroy(new Error('connection reset'));
            }
        })
    });
    await fetch(`${base}/w500/cut.jpg`)
        .then((r) => r.arrayBuffer())
        .catch(() => {});
    await settle();
    assert.deepEqual(leftovers('w500'), []);
});

test('only TMDB-shaped names and known sizes: nothing outside the folder is reachable', async () => {
    for (const bad of ['w342/..%2F..%2Fsecret.jpg', 'w342/abc.svg', 'original/abc.jpg', 'w342/a.b.jpg']) {
        assert.equal((await fetch(`${base}/${bad}`)).status, 400, bad);
    }
    assert.equal(asked, 0);
});

test('the sweep drops posters unopened for months and broken downloads, and keeps the rest', async () => {
    const dir = path.join(DIR, 'w92');
    fs.mkdirSync(dir, { recursive: true });
    const put = (name, ageMs) => {
        const full = path.join(dir, name);
        fs.writeFileSync(full, IMAGE);
        const t = new Date(Date.now() - ageMs);
        fs.utimesSync(full, t, t);
    };
    put('old.jpg', (MAX_AGE_DAYS + 1) * 86400e3);
    put('recent.jpg', 86400e3);
    put('broken.jpg.1.2.x.part', 2 * 3600e3);
    put('downloading.jpg.1.2.y.part', 60e3);
    assert.equal(await sweepPosters(), 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['downloading.jpg.1.2.y.part', 'recent.jpg']);
});

test('serving from disk starts the age over, so a poster in use is never swept', async () => {
    const full = stored('w342', 'abc.jpg');
    const old = new Date(Date.now() - (MAX_AGE_DAYS - 1) * 86400e3);
    fs.utimesSync(full, old, old);
    await (await fetch(`${base}/w342/abc.jpg`)).arrayBuffer();
    await settle();
    assert.ok(Date.now() - fs.statSync(full).mtimeMs < 60e3);
});

test('the browser leaving halfway: the download still finishes and the poster is kept whole', async () => {
    const BIG = Buffer.alloc(4 * 1024 * 1024, 7); // bigger than every buffer on the way, so it backs up
    upstream = () => {
        let sent = 0;
        return {
            headers: JPEG,
            data: new Readable({
                read() {
                    if (sent >= BIG.length) return this.push(null);
                    const chunk = BIG.subarray(sent, sent + 64 * 1024);
                    sent += chunk.length;
                    setTimeout(() => this.push(chunk), 1);
                }
            })
        };
    };
    const leave = new AbortController();
    const res = await fetch(`${base}/w500/big.jpg`, { signal: leave.signal });
    await res.body.getReader().read(); // the first bytes, then gone
    leave.abort();
    for (let i = 0; i < 50 && !fs.existsSync(stored('w500', 'big.jpg')); i++) await settle();
    assert.equal(fs.statSync(stored('w500', 'big.jpg')).size, BIG.length);
});

test('TMDB answering 200 with something that is not an image (a proxy page): passed on, not kept', async () => {
    upstream = () => ({ headers: { 'content-type': 'text/html' }, data: Readable.from([Buffer.from('<html>')]) });
    const res = await fetch(`${base}/w185/proxy.jpg`);
    await res.arrayBuffer();
    await settle();
    assert.deepEqual(
        leftovers('w185').filter((f) => f.startsWith('proxy')),
        []
    );
    assert.equal(res.headers.get('cache-control'), null);
});

test('TMDB going quiet halfway: the request ends after the deadline, nothing kept', { timeout: 5000 }, async () => {
    upstream = () => ({
        headers: JPEG,
        data: new Readable({
            read() {
                if (!this.started) this.push(IMAGE.subarray(0, 5));
                this.started = true; // and then nothing, for ever
            }
        })
    });
    process.env.POSTER_BODY_TIMEOUT_MS = '300';
    const started = Date.now();
    await fetch(`${base}/w342/quiet.jpg`)
        .then((r) => r.arrayBuffer())
        .catch(() => {});
    delete process.env.POSTER_BODY_TIMEOUT_MS;
    assert.ok(Date.now() - started < 3000, 'ended by the deadline');
    await settle();
    assert.deepEqual(
        leftovers('w342').filter((f) => f.startsWith('quiet')),
        []
    );
});

test('the recap cards take a poster from the disk; a bad address or TMDB down gives none', async () => {
    fs.mkdirSync(path.join(DIR, 'w342'), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'w342', 'kept.jpg'), IMAGE);
    const get = mock.method(axios, 'get', async () => {
        throw new Error('TMDB down');
    });
    assert.deepEqual(await posterBytes('https://image.tmdb.org/t/p/w500/kept.jpg'), IMAGE);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(await posterBytes('https://image.tmdb.org/t/p/w500/missing.jpg'), null);
    assert.equal(await posterBytes('https://image.tmdb.org/t/p/w500/../../etc.jpg'), null);
    assert.equal(await posterBytes(null), null);
    get.mock.restore();
});
