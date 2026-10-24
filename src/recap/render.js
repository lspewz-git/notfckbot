/**
 * The recap cards as PNG images. The elements come from cards.js, the drawing happens in the
 * drawing threads (pool.js, worker.js), so the bot keeps answering meanwhile; finished sets are
 * kept on disk (store.js) and drawn again only when what they show has changed. The panel's
 * preview and the sending share them.
 */
const { Chat } = require('../db');
const { loadChatStats } = require('../chat-stats');
const { posterBytes } = require('../admin/posters');
const { lruCache } = require('../lru');
const { log } = require('../log');
const { recapCards } = require('./cards');
const { draw } = require('./pool');
const backgrounds = require('./backgrounds');
const store = require('./store');

/** One card's PNG. */
const renderCard = (element) => draw({ kind: 'card', element });

/** A poster as a data URI for a card, or null (none, or TMDB not answering). */
async function posterUri(url) {
    const bytes = await posterBytes(url);
    if (!bytes) return null;
    const type = String(url).endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${bytes.toString('base64')}`;
}

/**
 * What a chat's year is drawn from, and its fingerprint; null for a chat that isn't there.
 * @param {Array} [looks] cardLooks(), when asked for many chats at once
 */
async function recapInputs(chatId, year, { now = new Date(), looks } = {}) {
    const chat = await Chat.findByPk(chatId);
    if (!chat) return null;
    const stats = await loadChatStats(chatId, { from: `${year}-01-01`, to: `${year}-12-31` }, now);
    if (!stats) return null;
    const cardLooks = looks || (await backgrounds.cardLooks());
    const chatName = chat.username || String(chat.id);
    const poster = (stats.best[0] && stats.best[0].poster_url) || null;
    const hash = store.fingerprint({
        year: Number(year),
        chatName,
        stats,
        looks: cardLooks.map((l) => [l.background, l.dim]),
        poster
    });
    return { stats, chatName, looks: cardLooks, poster, hash };
}

/**
 * The six elements for a year's inputs, with the poster and pictures they need. complete: false
 * when one of them could not be had (TMDB not answering for the poster, a picture gone): the cards
 * are drawn without it, and not kept as if they showed it.
 */
async function elementsFor(inputs, year, looks = inputs.looks) {
    const posters = new Map();
    let complete = true;
    if (inputs.poster) {
        const uri = await posterUri(inputs.poster);
        if (uri) posters.set(inputs.poster, uri);
        else complete = false;
    }
    const pictures = await backgrounds.looksForDrawing(looks);
    if (pictures.missing) complete = false;
    const elements = recapCards(inputs.stats, { year, chatName: inputs.chatName, posters, looks: pictures.looks });
    return { elements, complete };
}

// Bumped when a chat's files or the backgrounds change: a drawing started before doesn't write
// its (now old) set back. One counter for all, as "every chat" changes are rare
let generation = 0;
// A chat's year drawn once at a time: a second ask joins the drawing under way
const drawingNow = new Map();

async function drawAndKeep(chatId, year, now) {
    const started = generation;
    const inputs = await recapInputs(chatId, year, { now });
    if (!inputs) return undefined;
    const kept = await store.readSet(chatId, year, inputs.hash).catch(() => null);
    if (kept) return { images: kept, stats: inputs.stats };

    const { elements, complete } = await elementsFor(inputs, year);
    // All at once: the pool runs as many as it has threads, the rest wait their turn
    const images = await Promise.all(elements.map(renderCard));
    if (complete && started === generation) {
        const thumbs = await Promise.all(images.map((png) => draw({ kind: 'thumb', png })));
        // A disk that refuses the write still gets the chat its cards
        await store
            .writeSet(chatId, year, inputs.hash, images, thumbs)
            .catch((err) => log.error(`[Recap] Could not keep the cards of ${chatId}: ${err.message}`));
    }
    return { images, stats: inputs.stats };
}

/**
 * The six PNGs of a chat's year and the statistics they show (for the message's caption): from
 * the disk when they are there and still show the same, else drawn and kept. Undefined (not kept
 * by the memory cache) for a chat that isn't there.
 */
function drawRecap(chatId, year, now = new Date()) {
    const key = `${chatId}:${year}`;
    if (!drawingNow.has(key)) {
        drawingNow.set(
            key,
            drawAndKeep(chatId, year, now).finally(() => drawingNow.delete(key))
        );
    }
    return drawingNow.get(key);
}

// The panel asks for the six one by one: one drawing (or one read from the disk) answers them all.
// Bounded by bytes too: six cards on photos are about 15 MB
const recapCache = lruCache({
    max: 20,
    maxSize: 60 * 1024 * 1024,
    sizeCalculation: (value) =>
        Math.max(
            1,
            value.images.reduce((sum, png) => sum + png.length, 0)
        ),
    ttl: 10 * 60 * 1000,
    fetchMethod: (key) => {
        const [chatId, year] = key.split(':');
        return drawRecap(chatId, Number(year));
    }
});

/**
 * A chat's year: { images: six PNG Buffers, stats }; null for no chat.
 */
const recapImages = async (chatId, year) => (await recapCache.fetch(`${chatId}:${year}`)) || null;

/**
 * Forgets what memory holds of a chat's year (or of every chat's), after its files or the
 * backgrounds changed; a drawing under way then keeps its cards to itself.
 */
function forgetRecap(chatId, year) {
    generation += 1;
    if (chatId === undefined) recapCache.clear();
    else recapCache.delete(`${chatId}:${year}`);
}

/**
 * Card n of a chat's year drawn on another look ({ background, dim }), for the panel's picker:
 * drawn every time, never kept. Null for no chat.
 */
async function previewCard(chatId, year, n, look) {
    const inputs = await recapInputs(chatId, year);
    if (!inputs) return null;
    const looks = inputs.looks.map((l) => (l.card === n ? { ...l, ...look } : l));
    const { elements } = await elementsFor(inputs, year, looks);
    return renderCard(elements[n - 1]);
}

// "Draw missing and out of date": one run at a time, a chat after another
const drawing = { running: false, left: 0 };

/**
 * Draws these chats' years in the background, one after another, at the drawing threads' low
 * priority; a chat already drawn and still the same is only read. Returns at once; false when a
 * run is already going.
 */
function drawInBackground(chatIds, year) {
    if (drawing.running) return false;
    drawing.running = true;
    drawing.left = chatIds.length;
    (async () => {
        for (const chatId of chatIds) {
            try {
                // Straight to the disk: through the memory cache it would fill it with every chat
                await drawRecap(chatId, year);
            } catch (err) {
                log.error(`[Recap] Drawing the cards of ${chatId} failed: ${err.message}`);
            }
            drawing.left -= 1;
        }
    })().finally(() => {
        drawing.running = false;
        drawing.left = 0;
    });
    return true;
}

/** How the background drawing goes: { running, left }. */
const drawingState = () => ({ ...drawing });

module.exports = {
    recapImages,
    recapInputs,
    renderCard,
    drawRecap,
    forgetRecap,
    previewCard,
    drawInBackground,
    drawingState
};
