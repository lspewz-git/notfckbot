/**
 * The proxy setting (src/proxy.js): which URLs can be saved, the password kept out of sight, and
 * a broken value in .env not taking the bot down. Run: npm run test:unit
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { proxyUrlProblem, getProxyAgent, redactProxyUrl, withSavedPassword } = require('../../src/proxy');

const saved = process.env.TMDB_PROXY_URL;
afterEach(() => {
    process.env.TMDB_PROXY_URL = saved || '';
});

test('usable: none at all, and http(s) or socks with a host and a port', () => {
    for (const url of ['', 'http://10.0.0.5:3128', 'https://u:p@proxy.lan:443', 'socks5h://u:p%40ss@[::1]:1080']) {
        assert.equal(proxyUrlProblem(url), null, url);
    }
});

test('refused before saving: what the agents cannot parse, other schemes, no host', () => {
    assert.match(proxyUrlProblem('http://host:99999'), /not valid/);
    assert.match(proxyUrlProblem('socks5://host:abc'), /not valid/);
    assert.match(proxyUrlProblem('http://[bad'), /not valid/);
    assert.match(proxyUrlProblem('ftp://host:21'), /must start with/);
    assert.match(proxyUrlProblem('socks5://'), /no host/);
});

test('a broken value already in .env: a direct connection, not an error on every request', () => {
    process.env.TMDB_PROXY_URL = 'http://host:99999';
    assert.equal(getProxyAgent(), null);
    process.env.TMDB_PROXY_URL = 'socks5://127.0.0.1:1080';
    assert.ok(getProxyAgent(), 'a good value afterwards is picked up');
});

test('certificates stay verified through the proxy: the bot token and the TMDB key go this way', () => {
    for (const url of ['socks5://127.0.0.1:1080', 'http://127.0.0.1:3128', 'https://proxy.example:443']) {
        process.env.TMDB_PROXY_URL = url;
        const agent = getProxyAgent();
        assert.ok(agent, url);
        // Where each agent keeps what it hands to tls.connect: for the site, the proxy and the SOCKS hop
        for (const key of ['options', 'connectOpts', 'socketOptions']) {
            assert.notEqual(agent[key]?.rejectUnauthorized, false, `${url}: ${key} turns verification off`);
        }
    }
});

test('the password never leaves the server, and an empty password field keeps the saved one', () => {
    assert.equal(redactProxyUrl('socks5://user:secret@10.0.0.5:1080'), 'socks5://user@10.0.0.5:1080');
    const kept = withSavedPassword('socks5h://user@10.0.0.5:1080', 'socks5://user:secret@10.0.0.5:1080');
    assert.equal(kept, 'socks5h://user:secret@10.0.0.5:1080');
    // Another host: the saved password is not handed to it
    assert.equal(
        withSavedPassword('socks5://user@evil.example:1080', 'socks5://user:secret@10.0.0.5:1080'),
        'socks5://user@evil.example:1080'
    );
});
