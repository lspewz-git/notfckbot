/**
 * A group upgraded to a supergroup: Telegram posts a service message in the old chat
 * (migrate_to_chat_id) and in the new one (migrate_from_chat_id). Either moves the chat's data to
 * the new id (src/chat-migration.js); the other then finds nothing left to move.
 */
const { migrateChat } = require('../chat-migration');
const { log } = require('../log');

/** The old and the new id an update announces, or null. */
function migrationOf(update) {
    const message = update && update.message;
    if (!message || !message.chat) return null;
    if (message.migrate_to_chat_id) return { from: message.chat.id, to: message.migrate_to_chat_id };
    if (message.migrate_from_chat_id) return { from: message.migrate_from_chat_id, to: message.chat.id };
    return null;
}

function register(bot) {
    bot.use(async (ctx, next) => {
        const move = migrationOf(ctx.update);
        if (!move) return next();
        try {
            await migrateChat(move.from, move.to);
        } catch (err) {
            log.error(`[Bot] Moving group ${move.from} to supergroup ${move.to} failed: ${err.message}`);
        }
        // A service message: nothing for the other handlers to answer
    });
}

module.exports = { register, migrationOf };
