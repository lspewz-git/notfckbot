const { isLocalHost } = require('./panel-only');

// Public redirects belong to the VPS; direct HTTP keeps the VM address and uses HTTPS 443.
function localHttpsRedirect(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
    }
    const host = req.headers.host || '';
    if (!isLocalHost(host) || /[\s\\/@?#]/.test(host)) {
        res.writeHead(421).end();
        return;
    }
    let target;
    try {
        target = new URL(`https://${host}`);
    } catch {
        res.writeHead(421).end();
        return;
    }
    target.port = '';
    const requestPath = req.url?.startsWith('/') ? req.url : '/';
    res.writeHead(308, { Location: target.origin + requestPath }).end();
}

module.exports = { localHttpsRedirect };
