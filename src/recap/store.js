/**
 * Finished recap cards on disk, through cacache: a chat's six PNGs for a year, with small copies
 * for the panel's lists. Each set carries the fingerprint of what it was drawn from (the chat's
 * figures, its name, the backgrounds, the code and packages that draw): a set whose fingerprint no
 * longer matches is out of date and drawn again when next needed. Survives restarts; the preview
 * and the sending use the same files. Changes go one at a time (disk.js); a set drawn again
 * replaces the old one's files instead of piling up beside them.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cacache = require('cacache');
const { locked, integritiesOf, dropUnused, removeKeys } = require('./disk');

/** Read on every call, so a test can point it at a temporary folder. */
const storeDir = () => process.env.RECAP_CARDS_DIR || path.join(__dirname, '../../data/recap/cards');

// A change to how the cards look draws every set again: the code that builds and draws them, and
// the versions of the packages that lay out, draw and give the letters
/** A package's version, from its package.json found above its entry (some don't export the file). */
function versionOf(pkg) {
    let dir = path.dirname(require.resolve(pkg));
    for (;;) {
        const file = path.join(dir, 'package.json');
        if (fs.existsSync(file)) {
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (json.name === pkg) return json.version;
        }
        const up = path.dirname(dir);
        if (up === dir) return 'unknown';
        dir = up;
    }
}
const CODE = crypto
    .createHash('sha256')
    .update(
        ['cards.js', 'worker.js', 'size.js', 'render.js', 'backgrounds.js']
            .map((f) => fs.readFileSync(path.join(__dirname, f)))
            .join()
    )
    .update(['satori', '@resvg/resvg-wasm', '@fontsource/manrope', '@fontsource/unbounded'].map(versionOf).join())
    .digest('hex');

const CARDS = 6;
const cardKey = (year, chatId, n) => `card:${year}:${chatId}:${n}`;
const thumbKey = (year, chatId, n) => `thumb:${year}:${chatId}:${n}`;
const setKey = (year, chatId) => `set:${year}:${chatId}`;
const keysOf = (year, chatId) => {
    const keys = [setKey(year, chatId)];
    for (let n = 1; n <= CARDS; n += 1) keys.push(cardKey(year, chatId, n), thumbKey(year, chatId, n));
    return keys;
};

/**
 * The fingerprint of what a set is drawn from.
 * @param {object} what { year, chatName, stats, looks (card looks: background id and dim), poster }
 */
const fingerprint = (what) => crypto.createHash('sha256').update(CODE).update(JSON.stringify(what)).digest('hex');

/** The six PNGs of a chat's year when they are there and drawn from this fingerprint, else null. */
async function readSet(chatId, year, hash) {
    const dir = storeDir();
    const set = await cacache.get.info(dir, setKey(year, chatId));
    if (!set || set.metadata.hash !== hash) return null;
    try {
        const cards = await Promise.all(
            Array.from({ length: CARDS }, (_, i) => cacache.get(dir, cardKey(year, chatId, i + 1)))
        );
        // Written in turn: a card of another drawing (the set's write cut short) is no match
        if (cards.some((c) => c.metadata.hash !== hash)) return null;
        return cards.map((c) => c.data);
    } catch {
        return null;
    }
}

/**
 * Keeps a chat's six PNGs and their small copies, in place of the set it had: the set's entry
 * last, so it only names whole sets; the old set's files go.
 */
function writeSet(chatId, year, hash, images, thumbs) {
    const dir = storeDir();
    return locked(dir, async () => {
        const old = await integritiesOf(dir, keysOf(year, chatId));
        const metadata = { hash };
        for (let i = 0; i < CARDS; i += 1) {
            await cacache.put(dir, cardKey(year, chatId, i + 1), images[i], { metadata });
            await cacache.put(dir, thumbKey(year, chatId, i + 1), thumbs[i], { metadata });
        }
        const bytes = [...images, ...thumbs].reduce((sum, b) => sum + b.length, 0);
        await cacache.put(dir, setKey(year, chatId), Buffer.from('1'), {
            metadata: { hash, drawnAt: new Date().toISOString(), bytes }
        });
        await dropUnused(dir, old);
    });
}

/** The sets kept for a year: { chatId, hash, drawnAt, bytes }. */
async function listSets(year) {
    const entries = await cacache.ls(storeDir()).catch(() => ({}));
    const prefix = `set:${year}:`;
    return Object.values(entries)
        .filter((e) => e.key.startsWith(prefix))
        .map((e) => ({
            chatId: e.key.slice(prefix.length),
            hash: e.metadata.hash,
            drawnAt: e.metadata.drawnAt,
            bytes: e.metadata.bytes
        }));
}

/** A small copy of card n of a chat's set, or null. */
async function readThumb(chatId, year, n) {
    try {
        return (await cacache.get(storeDir(), thumbKey(year, chatId, n))).data;
    } catch {
        return null;
    }
}

/** Removes a chat's set and its files. */
function removeSet(chatId, year) {
    const dir = storeDir();
    return locked(dir, () => removeKeys(dir, keysOf(year, chatId)));
}

/** Removes every set of a year; returns how many. */
function removeYear(year) {
    const dir = storeDir();
    return locked(dir, async () => {
        const sets = await listSets(year);
        await removeKeys(
            dir,
            sets.flatMap((s) => keysOf(year, s.chatId))
        );
        return sets.length;
    });
}

module.exports = { fingerprint, readSet, writeSet, listSets, readThumb, removeSet, removeYear };
