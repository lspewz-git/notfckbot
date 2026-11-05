const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localHttpsRedirect } = require('../../src/admin/http-redirect');

function redirect(host, url = '/?miniapp=1', method = 'GET') {
    const result = {};
    localHttpsRedirect(
        { headers: { host }, url, method },
        {
            writeHead(status, headers) {
                Object.assign(result, { status, headers });
                return this;
            },
            end() {}
        }
    );
    return result;
}

test('VM HTTP keeps the direct host, path and query while switching to HTTPS 443', () => {
    for (const [host, target] of [
        ['192.168.2.112', '192.168.2.112'],
        ['192.168.2.112:80', '192.168.2.112'],
        ['[fd00::1]:80', '[fd00::1]'],
        ['bot.lan', 'bot.lan']
    ]) {
        assert.deepEqual(redirect(host), { status: 308, headers: { Location: `https://${target}/?miniapp=1` } });
        assert.equal(
            redirect(host, '//evil.example/path', 'HEAD').headers.Location,
            `https://${target}//evil.example/path`
        );
    }
});

test('VM does not redirect public domains or malformed Host values', () => {
    for (const host of ['notfck.top:41812', 'evil.example', 'localhost@evil.example', 'localhost\\evil', '[bad]', '']) {
        assert.equal(redirect(host).status, 421);
    }
    assert.deepEqual(redirect('192.168.2.112', '/', 'POST'), { status: 405, headers: { Allow: 'GET, HEAD' } });
});
