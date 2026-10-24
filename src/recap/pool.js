/**
 * The threads that draw the recap (src/recap/worker.js), through piscina. One core is left to the
 * bot: on one core one thread, at the lowest priority, so the bot still answers at once; on more,
 * a thread for each core but one. Threads start with work and end two minutes after the last,
 * taking their memory (fonts, satori, resvg: about 80 MB) with them.
 */
const os = require('os');
const path = require('path');
const { Piscina } = require('piscina');

const IDLE_MS = 2 * 60 * 1000;

let pool = null;

/** How many threads draw at once. */
const threads = () => Math.max(1, os.availableParallelism() - 1);

function getPool() {
    if (!pool) {
        pool = new Piscina({
            filename: path.join(__dirname, 'worker.js'),
            minThreads: 0,
            maxThreads: threads(),
            idleTimeout: IDLE_MS
        });
    }
    return pool;
}

/** Runs one drawing task in a thread (see worker.js for the tasks); its answer as a Buffer. */
const draw = async (task) => Buffer.from(await getPool().run(task));

/** Ends the threads now (on shutdown, and in tests). */
async function closePool() {
    if (!pool) return;
    const closing = pool;
    pool = null;
    await closing.destroy();
}

module.exports = { draw, closePool, threads };
