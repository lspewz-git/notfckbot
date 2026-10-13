/**
 * The API answers the admin panel's own page only (src/admin/panel-only.js).
 * Run: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refusal } = require('../../src/admin/panel-only');

const PANEL = { 'x-requested-by': 'notfckbot-panel' };
const req = (headers, path = '/stats') => ({ baseUrl: '/api', path, headers: { host: '192.168.2.112', ...headers } });

test("the panel's own requests pass: by IP, by a local name, from localhost", () => {
    assert.equal(refusal(req(PANEL)), null);
    assert.equal(refusal(req({ ...PANEL, origin: 'http://192.168.2.112' })), null, 'a POST carries the Origin');
    assert.equal(refusal(req({ ...PANEL, host: 'cinema-bot', origin: 'http://cinema-bot' })), null);
    assert.equal(refusal(req({ ...PANEL, host: 'cinema-bot.local:8080' })), null);
    assert.equal(refusal(req({ ...PANEL, host: 'localhost:3000' })), null);
    assert.equal(refusal(req({ ...PANEL, host: '[::1]:3000' })), null);
});

test('without the mark: a link opened in the browser, a plain curl, a form on another site', () => {
    assert.match(refusal(req({})), /admin panel only/);
    assert.match(refusal(req({ 'x-requested-by': 'something' })), /admin panel only/);
});

test('another site calling in: refused by its Origin, whatever headers it manages to send', () => {
    assert.match(refusal(req({ ...PANEL, origin: 'https://evil.example' })), /Cross-origin/);
    assert.match(refusal(req({ ...PANEL, origin: 'null' })), /Cross-origin/);
    // Same IP, another port: another origin
    assert.match(refusal(req({ ...PANEL, origin: 'http://192.168.2.112:8080' })), /Cross-origin/);
});

test("DNS rebinding: a site's own domain pointed at this server is not this server", () => {
    assert.match(refusal(req({ ...PANEL, host: 'evil.example', origin: 'http://evil.example' })), /Unknown host/);
    assert.match(refusal(req({ ...PANEL, host: '' })), /Unknown host/);
});

test('posters stay open to <img>, which sends no headers, but not to another host', () => {
    assert.equal(refusal(req({}, '/poster/w92/abc.jpg')), null);
    assert.match(refusal(req({ host: 'evil.example' }, '/poster/w92/abc.jpg')), /Unknown host/);
});
