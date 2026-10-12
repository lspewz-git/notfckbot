/**
 * Runs before every handler, in this order: a per-user throttle, then the chat record
 * (created or renamed), the block check and the repeated-message auto-block.
 */
const { Chat } = require('../db');
const { clearState } = require('./state');

// Anti-Spam: throttle to 1 request/second per user
// And track identical rapid commands for auto-blocking
const lastMessageTimes = {};
// Store shape: { text: lastCommandStr, count: duplicateCount, lastTime: timestamp }
const commandTracking = {};

setInterval(() => {
    // FIX: Memory leak — purge old anti-spam entries (older than 1 minute)
    const cutoff = Date.now() - 60_000;
    for (const userId of Object.keys(lastMessageTimes)) {
        if (lastMessageTimes[userId] < cutoff) {
            delete lastMessageTimes[userId];
        }
        if (commandTracking[userId] && commandTracking[userId].lastTime < cutoff) {
            delete commandTracking[userId];
        }
    }
}, 60_000);

function register(bot) {
    bot.use(async (ctx, next) => {
        // Determine userId whether it's a message, callback query, inline query, etc.
        const userId = ctx.from ? ctx.from.id : null;
        if (!userId) return next();

        // Button taps get a shorter window than messages: two quick taps are normal UI use,
        // and a dropped tap is answered with a hint instead of silence.
        const now = Date.now();
        const minGap = ctx.callbackQuery ? 400 : 1000;
        if (now - (lastMessageTimes[userId] || 0) < minGap) {
            console.log(`[Anti-Spam] Global Throttle: Ignoring rapid event from User ${userId}`);
            if (ctx.callbackQuery) {
                try {
                    await ctx.answerCbQuery('⏳ Секунду…');
                } catch (e) {}
            }
            return;
        }
        lastMessageTimes[userId] = now;
        return next();
    });

    bot.use(async (ctx, next) => {
        if (ctx.from) {
            // Track the specific user explicitly, whether they are in a group or private
            const userId = ctx.from.id;
            const username = ctx.from.username
                ? `@${ctx.from.username}`
                : `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();

            const [userData] = await Chat.findOrCreate({
                where: { id: userId },
                defaults: { type: 'private', username }
            });

            // Always update username if it changed
            if (userData.username !== username) {
                await userData.update({ username });
            }

            const now = Date.now();
            // Check if user is blocked
            if (userData.blockedUntil && userData.blockedUntil.getTime() > now) {
                // Text messages are dropped silently (the block notice was already sent), but a
                // button tap gets a popup so the user knows why nothing happens. Popups don't
                // add messages to the chat, so this can't be abused for spam.
                if (ctx.callbackQuery) {
                    const minutesLeft = Math.ceil((userData.blockedUntil.getTime() - now) / 60000);
                    try {
                        await ctx.answerCbQuery(
                            `🚫 Бот временно не отвечает из-за слишком частых действий. Осталось ~${minutesLeft} мин.`,
                            { show_alert: true }
                        );
                    } catch {
                        /* query expired */
                    }
                }
                return;
            }

            ctx.state = ctx.state || {};
            ctx.state.userData = userData; // Store the personal user record

            // Also ensure the actual group chat exists purely for settings like menu_enabled
            if (ctx.chat && ctx.chat.id !== userId) {
                // Groups/channels have a title; public ones also have a @username
                const chatTitle = ctx.chat.title || (ctx.chat.username ? `@${ctx.chat.username}` : null);

                const [chatData] = await Chat.findOrCreate({
                    where: { id: ctx.chat.id },
                    defaults: { type: ctx.chat.type, username: chatTitle }
                });

                // Groups get renamed — keep the stored title fresh
                if (chatTitle && chatData.username !== chatTitle) {
                    await chatData.update({ username: chatTitle });
                }

                ctx.state.chatData = chatData;
            } else {
                ctx.state.chatData = userData; // In private chats, user == chat
            }

            // --- SPAM PROTECTION LOGIC ---
            // Only repeated text messages can trigger the auto-block. Button taps are already rate
            // limited by the throttle above, and repeating one is normal UI use (re-opening a card,
            // paging back and forth), not spam.
            const spamText = ctx.message && ctx.message.text ? ctx.message.text : null;
            const spamMsgId = spamText ? ctx.message.message_id : null;

            if (spamText) {
                const trk = commandTracking[userId] || { text: '', count: 0, lastTime: 0, msgIds: [] };

                // If they sent the EXACT same text/button within 5 seconds...
                if (trk.text === spamText && now - trk.lastTime < 5000) {
                    trk.count += 1;
                    if (spamMsgId && !trk.msgIds.includes(spamMsgId)) trk.msgIds.push(spamMsgId);
                } else {
                    trk.text = spamText;
                    trk.count = 1;
                    trk.msgIds = spamMsgId ? [spamMsgId] : [];
                }
                trk.lastTime = now;
                commandTracking[userId] = trk;

                if (trk.count >= 3) {
                    // Auto-block for 5 minutes
                    const blockUntil = new Date(now + 5 * 60 * 1000);
                    await userData.update({ blockedUntil: blockUntil });
                    console.log(`[Anti-Spam] Auto-blocked user ${userId} for spamming: "${spamText}"`);

                    // 🧹 Clean up the spammed messages from the chat
                    const chatToClean = ctx.chat ? ctx.chat.id : null;
                    if (chatToClean && trk.msgIds.length > 0) {
                        for (const mId of trk.msgIds) {
                            try {
                                await ctx.telegram.deleteMessage(chatToClean, mId);
                            } catch (err) {
                                // Message might already be deleted or bot lacks rights
                            }
                        }
                    }

                    delete commandTracking[userId];
                    clearState(ctx);

                    // A duration rather than a clock time: users are in different time zones.
                    const notice =
                        '🚫 Слишком много одинаковых сообщений подряд, поэтому бот не будет отвечать 5 минут.\n\n' +
                        'Это защита от спама. После паузы всё снова заработает.';
                    try {
                        await ctx.reply(notice);
                    } catch (e) {
                        console.error('[Anti-Spam] Failed to send block notice:', e.message);
                    }

                    return; // Stop execution
                }
            }
        }
        return next();
    });
}

module.exports = { register };
