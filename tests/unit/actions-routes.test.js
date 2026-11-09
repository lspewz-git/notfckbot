/**
 * The panel's actions: the database wipe ("Danger zone") was removed on purpose and must not
 * come back by accident. Run: npm run test:unit
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listenForTest } = require('./http-server');

let close;
after(() => close?.());

test('there is no endpoint that wipes the database', async () => {
    const app = express();
    app.use(express.json());
    app.use(require('../../src/admin/routes/actions'));
    const listening = await listenForTest(app);
    close = listening.close;
    const res = await fetch(`${listening.base}/api/clear-all`, { method: 'POST' });
    assert.equal(res.status, 404);
});
