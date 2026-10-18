/**
 * TMDB posters for the panel, kept on the server's disk. A poster file never changes under its
 * name, so it is fetched from image.tmdb.org once and served from disk after that: the panel
 * shows posters with TMDB slow or unreachable, and the server stops downloading the same
 * images again for every browser. The folder sits in the project (mounted into the container),
 * so it survives restarts and rebuilds; files nobody asked for in MAX_AGE_DAYS go.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getProxyAgent } = require('../proxy');

const SIZES = new Set(['w92', 'w185', 'w342', 'w500']);
const FILE = /^[A-Za-z0-9]+\.(jpg|png)$/;
const TYPES = { jpg: 'image/jpeg', png: 'image/png' };
const MAX_AGE_DAYS = 90;
// axios's timeout covers the answer starting, not the image arriving: a TMDB that goes quiet
// halfway would hold the request open for good. Overridable for tests.
const bodyTimeout = () => Number(process.env.POSTER_BODY_TIMEOUT_MS) || 30000;

/** Read on every call, so a test can point it at a temporary folder. */
const cacheDir = () => process.env.POSTER_CACHE_DIR || path.join(__dirname, '../../data/posters');

const isValid = (size, file) => SIZES.has(size) && FILE.test(file);

/**
 * Sends the poster: from disk when it is there, otherwise from TMDB, writing it to disk on the way.
 * The download goes to a temporary name and is renamed only when complete, so a dropped
 * connection never leaves half an image to be served later.
 */
async function servePoster(size, file, res) {
    if (!isValid(size, file)) return res.status(400).end();
    const type = TYPES[file.split('.').pop()];
    const target = path.join(cacheDir(), size, file);
    res.set('Content-Type', type);
    // Poster files never change under the same name
    res.set('Cache-Control', 'public, max-age=604800, immutable');

    const stored = await fs.promises.stat(target).catch(() => null);
    if (stored && stored.size > 0) {
        // Asked for again: its age starts over, so the sweep keeps what is still in use
        const now = new Date();
        fs.promises.utimes(target, now, now).catch(() => {});
        res.set('Content-Length', String(stored.size));
        const disk = fs.createReadStream(target);
        disk.on('error', () => res.destroy());
        return disk.pipe(res);
    }

    let upstream;
    try {
        upstream = await axios.get(`https://image.tmdb.org/t/p/${size}/${file}`, {
            responseType: 'stream',
            timeout: 10000,
            httpsAgent: getProxyAgent(),
            proxy: false
        });
    } catch (err) {
        res.removeHeader('Cache-Control');
        return res.status(err.response ? err.response.status : 502).end();
    }

    // Only an image is kept: a proxy's or a captive network's page answering 200 would otherwise
    // be served as this poster for months
    const upstreamType = String((upstream.headers && upstream.headers['content-type']) || '');
    const keep = upstreamType.startsWith('image/');
    if (!keep) {
        res.removeHeader('Cache-Control');
        if (upstreamType) res.set('Content-Type', upstreamType);
    }

    // A unique temporary name: two browsers asking at once each write their own copy
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.part`;
    let copy = null;
    try {
        if (keep) {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            copy = fs.createWriteStream(temp);
        }
    } catch {
        // No room or no rights: the poster still goes to the browser, just not to disk
    }
    let failed = false;
    const drop = () => {
        failed = true;
        if (copy) {
            copy.destroy();
            fs.promises.unlink(temp).catch(() => {});
        }
    };
    if (copy) {
        copy.on('error', drop);
        copy.on('finish', () => {
            if (failed) return fs.promises.unlink(temp).catch(() => {});
            fs.promises.rename(temp, target).catch(() => fs.promises.unlink(temp).catch(() => {}));
        });
    }
    const deadline = setTimeout(() => upstream.data.destroy(new Error('poster download timed out')), bodyTimeout());
    // Without a listener, a connection dropped mid-download is an unhandled
    // 'error' event, and that takes the whole process down
    upstream.data.on('error', () => {
        clearTimeout(deadline);
        drop();
        res.destroy();
    });
    upstream.data.on('end', () => clearTimeout(deadline));
    upstream.data.on('data', (chunk) => copy && !failed && copy.write(chunk));
    upstream.data.on('end', () => copy && !failed && copy.end());
    // The browser leaving early doesn't spoil the copy: the download carries on to the disk
    upstream.data.pipe(res);
}

/** Deletes posters nobody asked for in MAX_AGE_DAYS, and leftovers of broken downloads. */
async function sweepPosters(now = Date.now()) {
    const root = cacheDir();
    let removed = 0;
    const sizes = await fs.promises.readdir(root).catch(() => []);
    for (const size of sizes) {
        const dir = path.join(root, size);
        const files = await fs.promises.readdir(dir).catch(() => []);
        for (const name of files) {
            const full = path.join(dir, name);
            const st = await fs.promises.stat(full).catch(() => null);
            if (!st || !st.isFile()) continue;
            const old = now - st.mtimeMs > MAX_AGE_DAYS * 86400e3;
            // A .part an hour old is a download that never finished
            const stale = name.endsWith('.part') && now - st.mtimeMs > 3600e3;
            if (old || stale) {
                await fs.promises.unlink(full).catch(() => {});
                removed += 1;
            }
        }
    }
    return removed;
}

module.exports = { servePoster, sweepPosters, cacheDir, MAX_AGE_DAYS };
