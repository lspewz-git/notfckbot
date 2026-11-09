/** Listen locally on a free port; callers keep their own app, requests and cleanup hooks. */
const { once } = require('node:events');

async function listenForTest(app) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    };
}

module.exports = { listenForTest };
