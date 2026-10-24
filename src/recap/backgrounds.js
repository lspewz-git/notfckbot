/**
 * Pictures the recap cards can be drawn on (Year recap → Backgrounds in the panel). An upload is
 * cropped to a card's 1080x1350 once, in the drawing thread, and kept on disk through cacache
 * (written whole or not at all); which card uses which picture, and how dimmed, is RecapLook.
 */
const crypto = require('crypto');
const path = require('path');
const cacache = require('cacache');
const { RecapLook } = require('../db');
const { draw } = require('./pool');
const { locked, removeKeys } = require('./disk');

const CARDS = 6;
const MAX_DIM = 80;

/** Read on every call, so a test can point it at a temporary folder. */
const storeDir = () => process.env.RECAP_BACKGROUNDS_DIR || path.join(__dirname, '../../data/recap/backgrounds');

const keyOf = (id) => `bg:${id}`;
const thumbOf = (id) => `bg-thumb:${id}`;
const ID = /^[a-f0-9]{16}$/;

/** Every picture, newest first: { id, name, size, uploadedAt, cards: card numbers using it }. */
async function listBackgrounds() {
    const [entries, looks] = await Promise.all([cacache.ls(storeDir()), RecapLook.findAll({ raw: true })]);
    return Object.values(entries)
        .filter((e) => e.key.startsWith('bg:'))
        .map((e) => ({
            id: e.key.slice(3),
            name: e.metadata.name,
            size: e.size,
            uploadedAt: e.metadata.uploadedAt,
            cards: looks
                .filter((l) => l.background === e.key.slice(3))
                .map((l) => l.card)
                .sort()
        }))
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

/**
 * Takes an uploaded PNG or JPEG: cropped to 1080x1350 and stored. Throws (with a message for the
 * panel) for anything that isn't a picture the drawing can read.
 */
async function addBackground(name, bytes) {
    const png = await draw({ kind: 'fit', bytes });
    const thumb = await draw({ kind: 'thumb', png, width: 240 });
    const id = crypto.randomBytes(8).toString('hex');
    const clean =
        String(name || 'picture')
            .replace(/[^\p{L}\p{N} ._-]/gu, '')
            .slice(0, 60) || 'picture';
    const dir = storeDir();
    await locked(dir, async () => {
        // The small copy first: a picture is listed (by its own entry) only once both are there
        await cacache.put(dir, thumbOf(id), thumb);
        await cacache.put(dir, keyOf(id), png, { metadata: { name: clean, uploadedAt: new Date().toISOString() } });
    });
    return { id, name: clean, size: png.length };
}

/** The picture's PNG (or its small copy, for the panel's lists), or null. */
async function backgroundBytes(id, { thumb = false } = {}) {
    if (!ID.test(String(id))) return null;
    try {
        return (await cacache.get(storeDir(), thumb ? thumbOf(id) : keyOf(id))).data;
    } catch {
        return null;
    }
}

/** Removes a picture; the cards drawn on it go back to their colour. False when there was none. */
async function removeBackground(id) {
    if (!ID.test(String(id)) || !(await cacache.get.info(storeDir(), keyOf(id)))) return false;
    await RecapLook.update({ background: null, dim: 0 }, { where: { background: id } });
    const dir = storeDir();
    await locked(dir, () => removeKeys(dir, [keyOf(id), thumbOf(id)]));
    return true;
}

/** The six cards in turn: { card, background (id or null), dim }. */
async function cardLooks() {
    const rows = await RecapLook.findAll({ raw: true });
    return Array.from({ length: CARDS }, (_, i) => {
        const row = rows.find((r) => r.card === i + 1);
        return { card: i + 1, background: (row && row.background) || null, dim: (row && row.dim) || 0 };
    });
}

/**
 * Sets what a card is drawn on: a stored picture and how dimmed (0 to 80%), or background null for
 * its plain colour. Throws for a picture that isn't there.
 */
async function setCardLook(card, { background, dim = 0 }) {
    if (background && !(await backgroundBytes(background))) throw new Error('No such picture');
    const value = background ? Math.max(0, Math.min(MAX_DIM, Math.round(dim))) : 0;
    await RecapLook.upsert({ card, background: background || null, dim: value });
}

// How light each picture is, by id: a picture never changes under its id, so measured once
const lightness = new Map();

/** A picture's average lightness, 0 to 1, measured in the drawing thread. */
function lightnessOf(id, bytes) {
    if (!lightness.has(id)) {
        const measuring = draw({ kind: 'luma', png: bytes });
        lightness.set(id, measuring);
        measuring.catch(() => lightness.delete(id));
    }
    return lightness.get(id);
}

/**
 * Light or dark text for a picture dimmed by dim percent: whichever reads on it. The cards' own
 * colours are for their plain backgrounds; on a photo the dark text of the cover would vanish.
 */
const toneFor = (light, dim) => (light * (1 - dim / 100) < 0.5 ? 'light' : 'dark');

/**
 * The looks for drawing: for each card, { uri, dim, tone } of its picture, or null; missing:
 * whether a picture a card should have could not be read (drawn without it, and not to be kept as
 * if it had).
 */
async function looksForDrawing(looks) {
    let missing = false;
    const drawn = await Promise.all(
        looks.map(async (look) => {
            if (!look.background) return null;
            const bytes = await backgroundBytes(look.background);
            if (!bytes) {
                missing = true;
                return null;
            }
            const tone = toneFor(await lightnessOf(look.background, bytes), look.dim || 0);
            return { uri: `data:image/png;base64,${bytes.toString('base64')}`, dim: look.dim, tone };
        })
    );
    return { looks: drawn, missing };
}

module.exports = {
    CARDS,
    MAX_DIM,
    listBackgrounds,
    addBackground,
    backgroundBytes,
    removeBackground,
    cardLooks,
    setCardLook,
    looksForDrawing,
    toneFor
};
