/**
 * Year recap → Backgrounds and Ready cards in the panel: the pictures the cards can be drawn on
 * (src/recap/backgrounds.js) and the finished sets kept on disk (src/recap/store.js).
 */
const multer = require('multer');
const { Chat, Subscription } = require('../../db');
const backgrounds = require('../../recap/backgrounds');
const store = require('../../recap/store');
const render = require('../../recap/render');
const ready = require('../../recap/ready');
const { z, valid, chatId } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const MAX_UPLOAD = 5 * 1024 * 1024;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD, files: 1 },
    fileFilter: (req, file, done) => done(null, ['image/png', 'image/jpeg'].includes(file.mimetype))
});

const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100, { error: 'Bad year' }) });
const pictureId = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/, { error: 'Bad picture id' }) });
// What multer hands over for the one file; no file (or another type, which multer drops) is refused
const uploaded = z.object(
    {
        originalname: z.string().max(255),
        mimetype: z.enum(['image/png', 'image/jpeg']),
        size: z.number().int().positive().max(MAX_UPLOAD),
        buffer: z.instanceof(Buffer)
    },
    { error: 'A PNG or JPEG picture, please' }
);
const cardNumber = z.coerce.number().int().min(1).max(backgrounds.CARDS, { error: 'Cards 1 to 6' });

const failed = (res, what) => (err) => {
    log.error(`[Admin] ${what} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
};

const png = (res, bytes, cache = 'no-store') => {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', cache);
    res.send(bytes);
};

// --- Backgrounds ---

/** A chat to draw the picker's preview for: one already drawn that year, else any that follows something. */
async function sampleChat(year) {
    const [set] = await store.listSets(year);
    const id = set ? set.chatId : ((await Subscription.findOne({ attributes: ['chatId'], raw: true })) || {}).chatId;
    if (!id) return null;
    const chat = await Chat.findByPk(id);
    return chat ? { id: String(chat.id), name: chat.username || String(chat.id) } : null;
}

router.get('/api/recap/looks', async (req, res) => {
    const query = valid(yearQuery, req.query, res);
    if (!query) return;
    try {
        const [cards, pictures, sample] = await Promise.all([
            backgrounds.cardLooks(),
            backgrounds.listBackgrounds(),
            sampleChat(query.year)
        ]);
        res.json({ cards, pictures, maxDim: backgrounds.MAX_DIM, sample });
    } catch (err) {
        failed(res, 'Recap looks')(err);
    }
});

router.post('/api/recap/backgrounds', (req, res) => {
    upload.single('picture')(req, res, async (err) => {
        if (err) {
            const tooBig = err.code === 'LIMIT_FILE_SIZE';
            return res.status(400).json({ error: tooBig ? 'Pictures up to 5 MB' : err.message });
        }
        if (!req.file) return res.status(400).json({ error: 'A PNG or JPEG picture, please' });
        const file = valid(uploaded, req.file, res);
        if (!file) return;
        try {
            const picture = await backgrounds.addBackground(file.originalname, file.buffer);
            log.info(`[Admin] Recap background added: ${picture.name}`);
            res.status(201).json(picture);
        } catch (e) {
            // The drawing could not read it: the panel says why
            res.status(400).json({ error: e.message });
        }
    });
});

router.get('/api/recap/backgrounds/:id', async (req, res) => {
    const params = valid(pictureId, req.params, res);
    if (!params) return;
    try {
        const bytes = await backgrounds.backgroundBytes(params.id, { thumb: req.query.size === 'thumb' });
        if (!bytes) return res.status(404).json({ error: 'No such picture' });
        // A picture never changes under its id
        png(res, bytes, 'private, max-age=604800, immutable');
    } catch (err) {
        failed(res, 'Recap background')(err);
    }
});

router.delete('/api/recap/backgrounds/:id', async (req, res) => {
    const params = valid(pictureId, req.params, res);
    if (!params) return;
    try {
        if (!(await backgrounds.removeBackground(params.id))) return res.status(404).json({ error: 'No such picture' });
        render.forgetRecap();
        log.info(`[Admin] Recap background ${params.id} removed`);
        res.json({ removed: true });
    } catch (err) {
        failed(res, 'Removing a recap background')(err);
    }
});

router.put('/api/recap/looks/:card', async (req, res) => {
    const params = valid(z.object({ card: cardNumber }), req.params, res);
    const body =
        params &&
        valid(
            z.object({
                background: pictureId.shape.id.nullable(),
                dim: z.coerce.number().int().min(0).max(backgrounds.MAX_DIM, { error: 'Dim 0 to 80%' }).default(0)
            }),
            req.body,
            res
        );
    if (!body) return;
    try {
        await backgrounds.setCardLook(params.card, body);
        render.forgetRecap();
        res.json({ cards: await backgrounds.cardLooks() });
    } catch (err) {
        if (err.message === 'No such picture') return res.status(404).json({ error: err.message });
        failed(res, 'Setting a recap card look')(err);
    }
});

// Card n of a chat's year drawn on a look not yet saved, for the picker. Drawn every time, kept nowhere
router.get('/api/recap/preview/:card', async (req, res) => {
    const params = valid(z.object({ card: cardNumber }), req.params, res);
    const query =
        params &&
        valid(
            yearQuery.extend({
                chat: chatId(),
                background: pictureId.shape.id.optional(),
                dim: z.coerce.number().int().min(0).max(backgrounds.MAX_DIM, { error: 'Dim 0 to 80%' }).default(0)
            }),
            req.query,
            res
        );
    if (!query) return;
    try {
        const look = { background: query.background || null, dim: query.background ? query.dim : 0 };
        const bytes = await render.previewCard(query.chat, query.year, params.card, look);
        if (!bytes) return res.status(404).json({ error: 'Chat not found' });
        png(res, bytes);
    } catch (err) {
        failed(res, 'Recap card preview')(err);
    }
});

// --- Ready cards ---

router.get('/api/recap/ready', async (req, res) => {
    const query = valid(yearQuery, req.query, res);
    if (!query) return;
    try {
        const rows = (await ready.readiness(query.year)).map(({ chat, id, set, state }) => ({
            chatId: id,
            name: chat.username || id,
            type: chat.type,
            state,
            drawnAt: set ? set.drawnAt : null,
            bytes: set ? set.bytes : 0
        }));
        res.json({ year: query.year, chats: rows, drawing: render.drawingState() });
    } catch (err) {
        failed(res, 'Ready recap cards')(err);
    }
});

router.get('/api/recap/ready/:chatId/thumb/:n', async (req, res) => {
    const params = valid(z.object({ chatId: chatId(), n: cardNumber }), req.params, res);
    const query = params && valid(yearQuery, req.query, res);
    if (!query) return;
    try {
        const bytes = await store.readThumb(params.chatId, query.year, params.n);
        if (!bytes) return res.status(404).json({ error: 'Not drawn' });
        png(res, bytes);
    } catch (err) {
        failed(res, 'Recap thumbnail')(err);
    }
});

router.delete('/api/recap/ready/:chatId', async (req, res) => {
    const params = valid(z.object({ chatId: chatId() }), req.params, res);
    const query = params && valid(yearQuery, req.query, res);
    if (!query) return;
    try {
        await store.removeSet(params.chatId, query.year);
        render.forgetRecap(params.chatId, query.year);
        res.json({ removed: 1 });
    } catch (err) {
        failed(res, 'Removing recap cards')(err);
    }
});

router.delete('/api/recap/ready', async (req, res) => {
    const query = valid(yearQuery, req.query, res);
    if (!query) return;
    try {
        const removed = await store.removeYear(query.year);
        render.forgetRecap();
        log.info(`[Admin] Recap cards of ${query.year} removed: ${removed} chat(s)`);
        res.json({ removed });
    } catch (err) {
        failed(res, 'Removing recap cards')(err);
    }
});

// How the background drawing goes, for the panel to follow it without counting every chat again
router.get('/api/recap/drawing', (req, res) => res.json(render.drawingState()));

// Draws the given chats (or every chat not ready) in the background; answers at once
router.post('/api/recap/draw', async (req, res) => {
    const body = valid(yearQuery.extend({ chatIds: z.array(chatId()).max(1000).optional() }), req.body, res);
    if (!body) return;
    try {
        const ids = body.chatIds || (await ready.toDraw(body.year));
        if (!render.drawInBackground(ids, body.year)) return res.status(409).json({ error: 'Already drawing' });
        log.info(`[Admin] Drawing recap cards of ${body.year} for ${ids.length} chat(s)`);
        res.json({ drawing: render.drawingState() });
    } catch (err) {
        failed(res, 'Drawing recap cards')(err);
    }
});

module.exports = router;
