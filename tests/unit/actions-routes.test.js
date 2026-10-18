/**
 * The panel's actions: the database wipe ("Danger zone") was removed on purpose and must not
 * come back by accident. Run: npm run test:unit
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let server;
after(() => server && server.close());

test('there is no endpoint that wipes the database', async () => {
    const app = express();
    app.use(express.json());
    app.use(require('../../src/admin/routes/actions'));
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/clear-all`, { method: 'POST' });
    assert.equal(res.status, 404);
});
