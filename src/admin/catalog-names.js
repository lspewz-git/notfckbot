/** Prepare public catalog names before sending panel data, never changing stored bot records. */
const tmdb = require('../api/tmdb');
const { lruCache, fetchFresh } = require('../lru');

const catalogId = (id) => (/^(tv|movie)_[1-9]\d{0,9}$/.test(String(id || '')) ? String(id) : null);
const seriesId = (id) => catalogId(id) || (/^[1-9]\d{0,9}$/.test(String(id || '')) ? `tv_${id}` : null);

function createPanelLocalizer(lookup = (...args) => tmdb.getPanelText(...args), budgetMs = 4500) {
    // Names have a larger, much smaller-per-entry cache than full descriptions. Languages never share keys.
    const names = lruCache({
        max: 3000,
        maxSize: 1024 * 1024,
        sizeCalculation: (name) => Math.max(1, name.length * 2),
        ttl: 6 * 60 * 60 * 1000,
        fetchMethod: async (key) => {
            const [kind, id, language] = key.split(':');
            const copy = await lookup(id, kind, language);
            const title = typeof copy?.title === 'string' ? copy.title.trim() : '';
            if (!title) throw new Error('Catalog name unavailable');
            return title;
        }
    });

    return async function localizePanel(req, payload, detailId = null) {
        const language = req.get('X-Panel-Language') === 'ru' ? 'ru-RU' : 'en-US';
        // Sequelize's toJSON and Dates keep exactly the same wire shape; all edits belong to this response.
        const data = JSON.parse(JSON.stringify(payload));
        const targets = new Map();
        function add(row, id, fields = ['title']) {
            id = catalogId(id);
            if (!id) return;
            for (const field of fields) {
                if (typeof row[field] !== 'string') continue;
                if (!targets.has(id)) targets.set(id, []);
                targets.get(id).push({ row, field });
            }
        }
        function walk(row) {
            if (!row || typeof row !== 'object') return;
            if (Array.isArray(row)) return row.forEach(walk);
            add(
                row,
                catalogId(row.tmdbId) ||
                    (row.tmdb_id && seriesId(row.tmdb_id)) ||
                    catalogId(row.id) ||
                    catalogId(`${row.kind}_${row.id}`)
            );
            if (row.Series) add(row.Series, seriesId(row.seriesId));
            for (const [key, value] of Object.entries(row)) if (key !== 'chat' && key !== 'Chat') walk(value);
        }
        walk(data);
        if (detailId) add(data, detailId, ['title', 'name']);
        if (!targets.size) return data;

        const jobs = [...targets.keys()];
        const resolved = new Map();
        // Cache hits must survive slow earlier jobs, expired refreshes and empty provider replies.
        for (const id of jobs) {
            const key = `${id.replace('_', ':')}:${language}`;
            const previous = names.get(key, { allowStale: true, noDeleteOnStaleGet: true });
            if (previous) resolved.set(id, previous);
        }
        const deadline = Date.now() + budgetMs;
        let next = 0;
        async function worker() {
            while (next < jobs.length && Date.now() < deadline) {
                const id = jobs[next++];
                const key = `${id.replace('_', ':')}:${language}`;
                try {
                    const name = await fetchFresh(names, key);
                    if (name) resolved.set(id, name);
                } catch {
                    // An unavailable catalog must leave a usable page and any known translation intact.
                }
            }
        }
        let timer;
        try {
            await Promise.race([
                Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker)),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, budgetMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
        // Late provider replies may warm the cache, but can never mutate an already returned payload.
        for (const [id, name] of resolved) for (const { row, field } of targets.get(id)) row[field] = name;
        return data;
    };
}

const localizePanel = createPanelLocalizer();
async function sendPanel(req, res, payload, detailId) {
    const data = await localizePanel(req, payload, detailId);
    res.vary('X-Panel-Language');
    return res.json(data);
}

module.exports = { createPanelLocalizer, localizePanel, sendPanel };
