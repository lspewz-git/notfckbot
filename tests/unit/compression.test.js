/**
 * The panel's files and the API's answers go compressed (brotli, else gzip) when the browser takes it
 * (src/admin/index.js). Run: npm run test:unit
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../../src/admin');

let server;
let port;
before(async () => {
    server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
});
after(() => server.close());

/** A GET with the browser's Accept-Encoding; fetch() would decode the body and hide the header. */
function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers: { 'Accept-Encoding': 'gzip, br', ...headers } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        }).on('error', reject);
    });
}

test('the page, its modules and styles go compressed: brotli when the browser takes it', async () => {
    for (const path of ['/', '/js/app.js', '/css/base.css', '/vendor/chart.umd.js']) {
        const res = await get(path);
        assert.equal(res.statusCode, 200, path);
        assert.equal(res.headers['content-encoding'], 'br', path);
    }
});

test('gzip for a browser without brotli', async () => {
    const res = await get('/js/app.js', { 'Accept-Encoding': 'gzip, deflate' });
    assert.equal(res.headers['content-encoding'], 'gzip');
});

test('a browser that does not ask for it gets the file as it is', async () => {
    const res = await get('/js/app.js', { 'Accept-Encoding': 'identity' });
    assert.equal(res.headers['content-encoding'], undefined);
});

test('HTML always revalidates while content-hashed assets stay immutable across repeat navigation', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.join(__dirname, '../../admin/dist/index.html'), 'utf8');
    const asset = /<script type="module" src="([^"]+)"/.exec(html)[1];
    const page = await get('/');
    assert.equal(page.headers['cache-control'], 'no-store');
    const first = await get(`/${asset}`);
    assert.equal(first.statusCode, 200);
    assert.match(first.headers['cache-control'], /max-age=31536000.*immutable/);
    const repeated = await get(`/${asset}`, { 'If-None-Match': first.headers.etag });
    assert.equal(repeated.statusCode, 304);
    assert.match(repeated.headers['cache-control'], /immutable/);
    assert.equal((await get('/assets/missing-old-hash.js')).statusCode, 404);
    assert.equal((await get('/login/test-token')).headers['cache-control'], 'no-store');
});
