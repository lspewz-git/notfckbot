const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { listenForTest } = require('./http-server');

test('chat table returns before Telegram and concurrent reloads share a bounded background backfill', async (t) => {
    const { Chat } = require('../../src/db');
    t.mock.method(require('../../src/telegram-ready'), 'isTelegramReady', () => true);
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let active = 0,
        peak = 0,
        calls = 0,
        written = 0;
    const chats = Array.from({ length: 9 }, (_, i) => ({
        id: -9000 - i,
        type: 'supergroup',
        username: null,
        toJSON() {
            return { id: this.id, type: this.type, username: this.username };
        },
        async update({ username }) {
            this.username = username;
            written++;
        }
    }));
    t.mock.method(Chat, 'findAll', async () => chats);
    t.mock.method(require('../../src/account/roles'), 'rolesOf', async () => new Map());
    t.mock.method(require('../../src/account/password'), 'withPasswords', async () => new Set());
    const app = require('express')();
    app.set('bot', {
        telegram: {
            async callApi() {
                calls++;
                peak = Math.max(peak, ++active);
                await gate;
                active--;
                return { title: 'Known group' };
            }
        }
    });
    app.use(require('../../src/admin/routes/data'));
    const server = await listenForTest(app);
    try {
        const response = await fetch(`${server.base}/api/data/chats`, { signal: AbortSignal.timeout(500) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).length, 9);
        const reload = await fetch(`${server.base}/api/data/chats`);
        await reload.json();
        assert.equal(calls, 4, 'reload joins the four existing lookups');
        release();
        for (let i = 0; i < 100 && written < 9; i++) await nextTurn();
        assert.equal(written, 9);
        assert.equal(peak, 4);
    } finally {
        release();
        for (let i = 0; i < 10; i++) await nextTurn();
        await server.close();
    }
});
