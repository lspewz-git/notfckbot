/**
 * The proxy dialog's Test (src/admin/routes/config.js): Telegram, TMDB and a neutral site asked at
 * once through the proxy, so a service that is down is told from a proxy that is.
 * Run: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkThroughProxy } = require('../../src/admin/routes/config');

const httpError = (status) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const connError = (code) => Object.assign(new Error(`connect ${code}`), { code });

/** A get() that answers per host. */
const getter = (answers) => async (url) => {
    const host = new URL(url).hostname;
    const answer = answers[host];
    if (answer instanceof Error) throw answer;
    return { data: answer };
};

test('everything through: three passes, and the address the proxy goes out from', async () => {
    const { checks, proxyDown } = await checkThroughProxy(
        null,
        getter({ 'api.telegram.org': '{}', 'api.themoviedb.org': '{}', 'ifconfig.me': '203.0.113.7\n' })
    );
    assert.equal(proxyDown, null);
    assert.deepEqual(
        Object.entries(checks).map(([name, c]) => [name, c.ok]),
        [
            ['telegram', true],
            ['tmdb', true],
            ['internet', true]
        ]
    );
    assert.equal(checks.internet.ip, '203.0.113.7');
});

test('TMDB answering with an error is TMDB, not the proxy', async () => {
    const { checks, proxyDown } = await checkThroughProxy(
        null,
        getter({ 'api.telegram.org': '{}', 'api.themoviedb.org': httpError(503), 'ifconfig.me': '203.0.113.7' })
    );
    assert.equal(proxyDown, null);
    assert.equal(checks.tmdb.error, 'replied 503');
});

test('both services down but the neutral site answers: the proxy works', async () => {
    const { proxyDown } = await checkThroughProxy(
        null,
        getter({
            'api.telegram.org': connError('ETIMEDOUT'),
            'api.themoviedb.org': connError('ETIMEDOUT'),
            'ifconfig.me': '203.0.113.7'
        })
    );
    assert.equal(proxyDown, null);
});

test('no target reached at all: the proxy itself is down', async () => {
    const refused = connError('ECONNREFUSED');
    const { proxyDown } = await checkThroughProxy(
        null,
        getter({ 'api.telegram.org': refused, 'api.themoviedb.org': refused, 'ifconfig.me': refused })
    );
    assert.equal(proxyDown, 'ECONNREFUSED');
});

test('the neutral site answering with something other than an address shows no IP', async () => {
    const { checks } = await checkThroughProxy(
        null,
        getter({ 'api.telegram.org': '{}', 'api.themoviedb.org': '{}', 'ifconfig.me': '<html>blocked</html>' })
    );
    assert.equal(checks.internet.ok, true);
    assert.equal(checks.internet.ip, undefined);
});

test("the bot token in Telegram's address never reaches the result", async () => {
    process.env.BOT_TOKEN = '123:SECRET';
    const { checks } = await checkThroughProxy(null, async (url) => {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND for ${url}`), {});
    });
    assert.doesNotMatch(JSON.stringify(checks), /SECRET/);
});
