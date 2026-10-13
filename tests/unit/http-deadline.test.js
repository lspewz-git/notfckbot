/**
 * A request's timeout covers the connection to the proxy (src/http-deadline.js): a proxy that
 * never answers used to hold requests for 30 s to over two minutes. Run: npm run test:unit
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { Agent } = require('agent-base');
const { installDeadline } = require('../../src/http-deadline');

/** A proxy agent whose connection never comes: like a proxy host that drops every packet. */
class SilentProxy extends Agent {
    connect() {
        return new Promise(() => {});
    }
}

// AbortSignal.timeout's timer doesn't hold the process open (the server always has something
// that does); with only a request that never connects, the test runner would see nothing left
let keepAlive;
before(() => {
    keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

test('a proxy that never answers: the request ends at its timeout, as an ordinary timeout', async () => {
    const client = installDeadline(axios.create({ timeout: 300, proxy: false }));
    const started = Date.now();
    await assert.rejects(client.get('https://example.com/', { httpsAgent: new SilentProxy() }), (err) => {
        assert.equal(err.code, 'ECONNABORTED');
        assert.match(err.message, /timeout of 300ms exceeded/);
        return true;
    });
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test("a caller's own abort signal is left alone", async () => {
    const client = installDeadline(axios.create({ timeout: 5000, proxy: false }));
    const controller = new AbortController();
    const request = client.get('https://example.com/', { httpsAgent: new SilentProxy(), signal: controller.signal });
    controller.abort();
    await assert.rejects(request, (err) => {
        assert.ok(axios.isCancel(err), 'still a cancel, not dressed up as a timeout');
        return true;
    });
});
