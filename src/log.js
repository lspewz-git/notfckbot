/**
 * The one logger (pino): a JSON line per entry on stdout, for `docker compose logs` and any log
 * viewer, and the last 200 entries in memory for the panel's Logs page.
 *
 *   log.info(`[Cron] Update check complete.`);
 *   log.error({ err }, '[Bot] Search error'); // the error's message and stack go along
 *
 * pino reads only the first argument as the text: put values in the string, not after it.
 * Quiet under `node --test`; LOG_LEVEL overrides the level.
 */
const pino = require('pino');

const BUFFER_SIZE = 200;
/** @type {{ type: 'log' | 'error', time: string, text: string }[]} */
const logBuffer = [];

// What the Logs page shows: the text, and the error's message when one was logged
const panel = {
    write(line) {
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            return;
        }
        const text = entry.err && entry.err.message ? `${entry.msg}: ${entry.err.message}` : entry.msg;
        logBuffer.push({
            type: entry.level === 'warn' || entry.level === 'error' || entry.level === 'fatal' ? 'error' : 'log',
            time: new Date(entry.time).toLocaleTimeString(),
            text: String(text)
        });
        if (logBuffer.length > BUFFER_SIZE) logBuffer.shift();
    }
};

/**
 * Only what helps to read a failure. An HTTP client's error carries its whole request, with the
 * API keys in its headers: logged as it is, they would end up in `docker compose logs`.
 */
function serializeError(err) {
    if (!err || typeof err !== 'object') return err;
    const { type, message, stack } = pino.stdSerializers.err(err);
    const status = err.response && (err.response.status || err.response.error_code);
    return {
        type,
        message,
        stack,
        ...(typeof err.code === 'string' || typeof err.code === 'number' ? { code: err.code } : {}),
        ...(status ? { status } : {})
    };
}

const level = process.env.LOG_LEVEL || (process.env.NODE_TEST_CONTEXT ? 'silent' : 'info');

const log = pino(
    {
        level,
        base: undefined, // no pid and hostname: one process in one container
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        serializers: { err: serializeError }
    },
    pino.multistream([
        { level: 'trace', stream: process.stdout },
        { level: 'trace', stream: panel }
    ])
);

module.exports = { log, logBuffer };
