/**
 * Per user and chat: where the conversation is (idle, waiting for a search query, paging results).
 * Telegraf's session() middleware keeps it in ctx.session, under "<user id>:<chat id>"; the store
 * is in memory, bounded, and drops a conversation 30 minutes after its last change. Swapping the
 * store (Valkey, a database) keeps it across restarts without touching the handlers.
 */
const { session } = require('telegraf');
const { lruCache } = require('../lru');

const STATE_TTL_MS = 30 * 60 * 1000;
const store = lruCache({ max: 10000, ttl: STATE_TTL_MS });

/** Registered before every other handler (src/bot/index.js). */
const stateSession = session({ store });

const getState = (ctx) => ctx.session || { state: 'idle' };

const setState = (ctx, data) => {
    ctx.session = { ...(ctx.session || {}), ...data };
};

/** Forgets everything about this user in this chat, e.g. on /start or an auto-block. */
const clearState = (ctx) => {
    ctx.session = null;
};

module.exports = { stateSession, getState, setState, clearState };
