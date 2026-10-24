/**
 * What the recap's two cacache folders (store.js, backgrounds.js) share: changes to a folder one
 * at a time, and removing entries together with the files nothing else points to. cacache's own
 * clean-up (verify) rebuilds the index and empties its temporary folder, so it can't run beside a
 * write; this removes exactly the files of the entries it removes, inside the same queue.
 */
const cacache = require('cacache');

const queues = new Map();

/** Runs fn after every change to this folder asked before it; its result. */
function locked(dir, fn) {
    const before = queues.get(dir) || Promise.resolve();
    const run = before.then(fn, fn);
    queues.set(
        dir,
        run.catch(() => {})
    );
    return run;
}

/** The files (integrities) these keys point to now. */
async function integritiesOf(dir, keys) {
    const infos = await Promise.all(keys.map((key) => cacache.get.info(dir, key).catch(() => null)));
    return infos.filter(Boolean).map((i) => i.integrity);
}

/** Removes the files among these that no entry of the folder points to any more. Inside locked(). */
async function dropUnused(dir, integrities) {
    if (!integrities.length) return;
    const live = new Set(Object.values(await cacache.ls(dir).catch(() => ({}))).map((e) => e.integrity));
    for (const integrity of new Set(integrities)) {
        if (!live.has(integrity)) await cacache.rm.content(dir, integrity).catch(() => {});
    }
}

/** Removes these entries and their files (unless another entry shares one). Inside locked(). */
async function removeKeys(dir, keys) {
    const integrities = await integritiesOf(dir, keys);
    for (const key of keys) await cacache.rm.entry(dir, key, { removeFully: true });
    await dropUnused(dir, integrities);
}

module.exports = { locked, integritiesOf, dropUnused, removeKeys };
