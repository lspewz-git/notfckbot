/**
 * The recap cards as PNG images: satori lays a card out into SVG, resvg draws the SVG. resvg's
 * WebAssembly build, not the native one: the native one kept about 40 MB more after every six
 * cards (measured 23.10), the WebAssembly one stays at its first size. The six of
 * a chat's year are drawn together (about a second) and kept for a while, so the panel's preview
 * and, later, the sending don't draw them again for every look.
 */
const fs = require('fs');
const path = require('path');
const resvg = require('@resvg/resvg-wasm');
const { Chat } = require('../db');
const { loadChatStats } = require('../chat-stats');
const { posterBytes } = require('../admin/posters');
const { lruCache } = require('../lru');
const { recapCards, WIDTH, HEIGHT } = require('./cards');

// satori is an ES module with a CommonJS build; loaded on first use, so the bot starts without it
let satori = null;
let fonts = null;
let wasmReady = null;

const FONT_DIR = path.join(__dirname, '../../node_modules/@fontsource');
// Each family comes as Latin and Cyrillic files; satori takes the first font of a name, so the
// Cyrillic half goes under a name of its own and the cards ask for "Manrope, Manrope Cyr"
const FONT_FILES = [
    ['Unbounded', 'unbounded', 700],
    ['Unbounded', 'unbounded', 900],
    ['Manrope', 'manrope', 600],
    ['Manrope', 'manrope', 700],
    ['Manrope', 'manrope', 800]
];

function loadFonts() {
    if (fonts) return fonts;
    fonts = FONT_FILES.flatMap(([name, dir, weight]) =>
        ['latin', 'cyrillic'].map((subset) => ({
            name: subset === 'latin' ? name : `${name} Cyr`,
            data: fs.readFileSync(path.join(FONT_DIR, dir, 'files', `${dir}-${subset}-${weight}-normal.woff`)),
            weight,
            style: 'normal'
        }))
    );
    return fonts;
}

/** One card's PNG. */
async function renderCard(element) {
    if (!satori) satori = require('satori').default;
    if (!wasmReady) wasmReady = resvg.initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    await wasmReady;
    const svg = await satori(element, { width: WIDTH, height: HEIGHT, fonts: loadFonts() });
    // Text is already shapes in satori's SVG: resvg needs no fonts of its own
    const drawing = new resvg.Resvg(svg, { font: { loadSystemFonts: false } });
    const image = drawing.render();
    try {
        return Buffer.from(image.asPng());
    } finally {
        // WebAssembly memory isn't the garbage collector's: freed by hand
        image.free();
        drawing.free();
    }
}

/** A poster as a data URI for a card, or null (none, or TMDB not answering). */
async function posterUri(url) {
    const bytes = await posterBytes(url);
    if (!bytes) return null;
    const type = String(url).endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${bytes.toString('base64')}`;
}

/** The six PNGs of a chat's year; undefined (not kept by the cache) for a chat that isn't there. */
async function drawRecap(chatId, year, now = new Date()) {
    const chat = await Chat.findByPk(chatId);
    if (!chat) return undefined;
    const stats = await loadChatStats(chatId, { from: `${year}-01-01`, to: `${year}-12-31` }, now);
    if (!stats) return undefined;
    const posters = new Map();
    const winner = stats.best[0];
    if (winner && winner.poster_url) {
        const uri = await posterUri(winner.poster_url);
        if (uri) posters.set(winner.poster_url, uri);
    }
    const chatName = chat.username || String(chat.id);
    const images = [];
    for (const card of recapCards(stats, { year, chatName, posters })) images.push(await renderCard(card));
    return images;
}

// Ten minutes: long enough to look at all six, short enough that a fresh look shows fresh figures
const recapCache = lruCache({
    max: 20,
    ttl: 10 * 60 * 1000,
    fetchMethod: (key) => {
        const [chatId, year] = key.split(':');
        return drawRecap(chatId, Number(year));
    }
});

/** The six PNGs (Buffers) of a chat's year, drawn once and kept for ten minutes; null for no chat. */
const recapImages = async (chatId, year) => (await recapCache.fetch(`${chatId}:${year}`)) || null;

module.exports = { recapImages, renderCard, drawRecap };
