/**
 * The browsers people sign in from, so the bot can tell a new one from a known one (like Telegram's
 * "Новый вход"): a long-lived nfb_device cookie marks the browser, AccountDevice remembers it per
 * user, and the country and network come from the client's IP in local DB-IP databases (no IP leaves
 * the server). A device seen for the first time less than a day ago can't end the user's other sessions
 * or change their password while the user has an older device (Telegram's rule against a hijacked
 * session locking the owner out).
 */
const crypto = require('crypto');
const fs = require('fs');
const maxmind = require('maxmind');
const { Op, UniqueConstraintError } = require('sequelize');
const { AccountDevice } = require('../db');
const { lruCache } = require('../lru');
const { log } = require('../log');
const { cookieValue } = require('./cookies');

const COOKIE = 'nfb_device';
const COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FRESH_MS = 24 * 60 * 60 * 1000;
// Not signed in from for this long: forgotten
const FORGET_MS = 400 * 24 * 60 * 60 * 1000;

const BROWSERS = [
    [/YaBrowser\//, 'Яндекс Браузер'],
    [/Edg(A|iOS)?\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/Firefox\/|FxiOS\//, 'Firefox'],
    [/Chrome\/|CriOS\//, 'Chrome'],
    [/Safari\//, 'Safari']
];
const SYSTEMS = [
    [/iPhone/, 'iPhone'],
    [/iPad/, 'iPad'],
    [/Android/, 'Android'],
    [/Windows/, 'Windows'],
    [/Macintosh|Mac OS X/, 'Mac'],
    [/Linux/, 'Linux']
];

/**
 * "Safari, iPhone": only a hint where the sign-in happened, so a few well-known names are enough
 * (no parser library for one line of text).
 */
function deviceName(ua = '') {
    const pick = (list) => list.find(([re]) => re.test(ua))?.[1];
    return [pick(BROWSERS), pick(SYSTEMS)].filter(Boolean).join(', ') || null;
}

// Telegram.WebApp.platform: the system when the web view's User-Agent doesn't tell it
const PLATFORMS = { ios: 'iPhone', android: 'Android', android_x: 'Android', macos: 'Mac' };

/**
 * "Telegram, iPhone", "Telegram Desktop, Windows", "Telegram Web, Mac": the Mini App in the Devices
 * list. platform is what the app's page reports (not signed, like the User-Agent): only for the name.
 */
function telegramName(platform = '', ua = '') {
    const system = SYSTEMS.find(([re]) => re.test(ua))?.[1] || PLATFORMS[platform];
    const app = platform === 'tdesktop' ? 'Telegram Desktop' : /^web/.test(platform) ? 'Telegram Web' : 'Telegram';
    return [app, system].filter(Boolean).join(', ');
}

// --- Where an IP is ---

let readers;
/** Both databases, read once (~20 MB); null when they can't be read: then there is just no place. */
function geo() {
    if (readers === undefined) {
        try {
            const open = (file) => new maxmind.Reader(fs.readFileSync(require.resolve(file)));
            readers = {
                country: open('@ip-location-db/dbip-country-mmdb/dbip-country.mmdb'),
                network: open('@ip-location-db/asn-mmdb/asn.mmdb')
            };
        } catch (err) {
            log.warn(`[Account] IP databases unavailable: ${err.message}`);
            readers = null;
        }
    }
    return readers;
}

// "PJSC \"Vimpelcom\"" → "Vimpelcom": the company form says nothing to the user
const FORMS =
    /^(?:PJSC|OJSC|JSC|PAO|AO|OOO|LLC|Ltd\.?|Inc\.?)\s+|,?\s+(?:PJSC|OJSC|JSC|LLC|Ltd\.?|Inc\.?|GmbH|B\.V\.|AG)$/i;
const networkName = (org) =>
    String(org || '')
        .replace(FORMS, '')
        .replace(FORMS, '')
        .replace(/^"(.*)"$/, '$1')
        .trim()
        .slice(0, 128) || null;

/** @returns {{ country: string | null, network: string | null }} */
function placeOf(ip) {
    const dbs = ip && maxmind.validate(ip) ? geo() : null;
    if (!dbs) return { country: null, network: null };
    try {
        const country = dbs.country.get(ip)?.country_code || null;
        const network = networkName(dbs.network.get(ip)?.autonomous_system_organization);
        return { country: /^[A-Z]{2}$/.test(country || '') ? country : null, network };
    } catch {
        return { country: null, network: null };
    }
}

let regions;
/** "Нидерланды" for NL. */
function countryName(code) {
    if (!code) return null;
    try {
        regions ??= new Intl.DisplayNames(['ru'], { type: 'region' });
        return regions.of(code) || code;
    } catch {
        return code;
    }
}

/** The client's address: behind Caddy, Express takes it from X-Forwarded-For (trust proxy). */
const ipOf = (req) => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;

// --- The browser's mark ---

const hash = (token) => crypto.createHash('sha256').update(`device:${token}`).digest('hex');

/**
 * The browser's device id, marking it first when it has no mark (or an unreadable one): then
 * req.deviceMarked stays false, and nothing is remembered for it until it comes back with the mark (a
 * client that drops cookies would add a row per request).
 */
function markOf(req, res) {
    if (req.deviceId) return req.deviceId;
    const value = cookieValue(req.headers.cookie, COOKIE);
    let token = TOKEN.test(value || '') ? value : null;
    req.deviceMarked = Boolean(token);
    if (!token) {
        token = crypto.randomBytes(32).toString('base64url');
        const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_TTL_MS / 1000}`];
        if (req.secure) parts.push('Secure');
        res.append('Set-Cookie', parts.join('; '));
    }
    req.deviceId = hash(token);
    return req.deviceId;
}

/**
 * Who is asking to sign in: the browser's mark, its name and where it is.
 * @returns {{ deviceId: string, name: string | null, ip: string | null, country: string | null,
 *   network: string | null }}
 */
function clientOf(req, res) {
    const ip = ipOf(req);
    return { deviceId: markOf(req, res), name: deviceName(req.get('user-agent')), ip, ...placeOf(ip) };
}

/** "Нидерланды, Vimpelcom · 95.24.17.80" (each part only when known). */
function placeLine(client) {
    if (!client) return '';
    const where = [countryName(client.country), client.network].filter(Boolean).join(', ');
    return [where, client.ip].filter(Boolean).join(' · ');
}

// --- Known devices ---

/**
 * How a sign-in from this browser looks for this user: 'known' (a trusted browser: signed in with a
 * confirmation in Telegram or from the Mini App), 'new', or 'odd': new and from a country none of the
 * user's trusted browsers was in. A browser signed in only by digits stays 'new' (the strict choice,
 * 05.11): a phished code from it still gets the cancel button.
 */
async function judge(userId, client) {
    if (!client?.deviceId) return 'new';
    const all = await AccountDevice.findAll({ where: { userId: String(userId) }, raw: true });
    const rows = all.filter((row) => row.trusted !== false);
    if (rows.some((row) => row.deviceId === client.deviceId)) return 'known';
    const countries = new Set(rows.map((row) => row.country).filter(Boolean));
    return client.country && countries.size && !countries.has(client.country) ? 'odd' : 'new';
}

// Recently seen devices: the guard doesn't ask the database on every request
const seenDevices = lruCache({ max: 5000, ttl: 60 * 60 * 1000 });
// "Это не я" for a browser whose row may not be written yet (its sign-in still on the way)
const denied = lruCache({ max: 5000, ttl: 60 * 60 * 1000 });
const seenKey = (userId, deviceId) => `${userId}:${deviceId}`;
let lastSweep = 0;

/**
 * This browser is the user's now: remembered (first seen at `since`, unless it already was), with
 * its latest name and place. trusted: true after a confirmed sign-in, false after digits nobody
 * confirmed yet; left out, a known row keeps what it had and a new one is trusted (a session from
 * before devices were remembered).
 * @returns {Promise<{ firstSeen: number }>}
 */
async function remember(req, res, userId, { since = Date.now(), trusted, now = Date.now() } = {}) {
    const client = clientOf(req, res);
    if (!req.deviceMarked) return { firstSeen: since };
    const key = seenKey(userId, client.deviceId);
    if (denied.has(key)) return { firstSeen: now };
    const trust = trusted === true;
    const where = { deviceId: client.deviceId, userId: String(userId) };
    const fields = { name: client.name, country: client.country, network: client.network, lastSeen: new Date(now) };
    let row = await AccountDevice.findOne({ where, raw: true });
    if (row) await AccountDevice.update(trust ? { ...fields, trusted: true } : fields, { where });
    else {
        try {
            await AccountDevice.create({
                ...where,
                ...fields,
                trusted: trust || trusted !== false,
                firstSeen: new Date(since)
            });
        } catch (err) {
            if (!(err instanceof UniqueConstraintError)) throw err;
            // Another request may have registered this browser after our lookup.
            row = await AccountDevice.findOne({ where, raw: true });
            if (!row) throw err;
            await AccountDevice.update(trust ? { ...fields, trusted: true } : fields, { where });
        }
    }
    // "Это не я" pressed while this was being written: it stays forgotten
    if (denied.has(key)) {
        await AccountDevice.destroy({ where });
        return { firstSeen: now };
    }
    const firstSeen = row ? new Date(row.firstSeen).getTime() : since;
    seenDevices.set(key, { firstSeen });
    if (now - lastSweep > 60 * 60 * 1000) {
        lastSweep = now;
        AccountDevice.destroy({ where: { lastSeen: { [Op.lt]: new Date(now - FORGET_MS) } } }).catch((err) =>
            log.warn(`[Account] Removing old devices failed: ${err.message}`)
        );
    }
    return { firstSeen };
}

/**
 * The guard's look at a signed-in browser: which device it is. A session from before devices were
 * remembered (or from another browser holding its cookie) counts from the session's own start.
 * @returns {Promise<{ firstSeen: number }>}
 */
async function seen(req, res, session) {
    const deviceId = markOf(req, res);
    const cached = seenDevices.get(seenKey(session.userId, deviceId));
    if (cached) return cached;
    const since = session.since ? new Date(session.since).getTime() : Date.now();
    // An unconfirmed digit sign-in keeps its browsers untrusted, even under a new cookie
    return remember(req, res, session.userId, {
        since: Math.min(since, Date.now()),
        trusted: session.trusted === false ? false : undefined
    });
}

/** "Это не я": this browser isn't the user's after all. */
async function forget(userId, deviceId) {
    if (!deviceId) return;
    const key = seenKey(userId, deviceId);
    denied.set(key, true);
    seenDevices.delete(key);
    await AccountDevice.destroy({ where: { deviceId, userId: String(userId) } });
}

const FRESH_ERROR =
    'For your safety, a device can do this one day after its first sign-in. Use a device you signed in on earlier.';

/**
 * Why this browser may not end other sessions or change the password yet, or null: it was first seen
 * less than a day ago and the user has an older device to do it from. The system account has no
 * Telegram to sign in again with, so it isn't held back.
 */
async function freshRefusal(req, now = Date.now()) {
    // No device known (its check failed): held back like a new one
    if (req.user.system || (req.device && req.device.firstSeen <= now - FRESH_MS)) return null;
    const older = await AccountDevice.count({
        where: {
            userId: String(req.user.userId),
            deviceId: { [Op.ne]: req.deviceId },
            firstSeen: { [Op.lte]: new Date(now - FRESH_MS) }
        }
    });
    return older ? FRESH_ERROR : null;
}

/**
 * Express middleware for the panel's routes that decide who gets in (roles, passwords, the bot's
 * token): refused where freshRefusal holds the device back. A sign-in someone was talked into
 * would otherwise outlive its cancelling.
 */
async function settledOnly(req, res, next) {
    try {
        const refusal = await freshRefusal(req);
        if (!refusal) return next();
        log.warn(
            `[Account] User ${req.user.userId} refused ${req.method} ${req.originalUrl}: a device signed in today`
        );
        res.status(403).json({ error: refusal });
    } catch (err) {
        log.error(`[Account] Device check failed: ${err.message}`);
        res.status(500).json({ error: 'Device check failed. Try again.' });
    }
}

/** For the tests: everything is looked up again. */
const resetDevices = () => {
    for (const cache of [seenDevices, denied]) cache.clear();
    lastSweep = 0;
};

module.exports = {
    COOKIE,
    FRESH_MS,
    deviceName,
    telegramName,
    ipOf,
    placeOf,
    countryName,
    placeLine,
    clientOf,
    judge,
    remember,
    seen,
    forget,
    freshRefusal,
    settledOnly,
    resetDevices
};
