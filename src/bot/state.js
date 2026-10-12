/** Per user and chat: where the conversation is (idle, waiting for a search query, paging results). */

const userStates = {};

const getStateKey = (ctx) => {
    const chatId = ctx.chat.id;
    const fromId = ctx.from ? ctx.from.id : 'unknown';
    return `${chatId}:${fromId}`;
};

const getState = (ctx) => userStates[getStateKey(ctx)] || { state: 'idle' };

const setState = (ctx, data) => {
    const key = getStateKey(ctx);
    userStates[key] = { ...(userStates[key] || {}), ...data, _lastActivity: Date.now() };
};

// FIX: Memory leak — purge idle state entries older than 30 minutes
const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes
setInterval(
    () => {
        const now = Date.now();
        for (const key of Object.keys(userStates)) {
            const last = userStates[key]._lastActivity || 0;
            if (now - last > STATE_TTL_MS) {
                delete userStates[key];
            }
        }
    },
    10 * 60 * 1000
); // Run cleanup every 10 minutes

/** Forgets everything about this user in this chat, e.g. on /start or an auto-block. */
const clearState = (ctx) => {
    delete userStates[getStateKey(ctx)];
};

module.exports = { getState, setState, clearState };
