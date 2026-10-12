/**
 * ⚙️ Settings: everything a chat can set about the bot, in one message. In a group anyone may
 * look, but only its admins may change things; in a private chat the user is the admin.
 */
const { Markup } = require('telegraf');
const { mainMenu } = require('./keyboards');
const { ownerOf } = require('./access');

const BUTTONS_LABEL = {
    owner: 'только тот, кто их вызвал',
    all: 'все участники'
};

const isGroup = (chat) => Boolean(chat) && chat.type !== 'private';

/** Whether the person behind this update may change the chat's settings. */
async function canChange(ctx) {
    if (!isGroup(ctx.chat)) return true;
    // An admin posting anonymously writes as the group itself (ctx.from is then Telegram's
    // @GroupAnonymousBot, which getChatMember wouldn't call an admin): only admins can do that
    const senderChat = ctx.message && ctx.message.sender_chat;
    if (senderChat && senderChat.id === ctx.chat.id) return true;
    try {
        const member = await ctx.getChatMember(ctx.from.id);
        return member.status === 'creator' || member.status === 'administrator';
    } catch {
        // Telegram didn't say: don't hand out a group's settings on a guess
        return false;
    }
}

/** The settings message: what is set now, and a button per setting to switch it. */
function settingsView(chat, settings) {
    const group = isGroup(chat);
    const menuOn = settings.menu_enabled !== false;
    const lines = ['⚙️ <b>Настройки чата</b>', ''];
    const rows = [];

    if (group) {
        const mode = settings.buttons_mode === 'all' ? 'all' : 'owner';
        lines.push(`🔘 Кнопки бота нажимают: <b>${BUTTONS_LABEL[mode]}</b>`);
        rows.push([
            Markup.button.callback(
                mode === 'all' ? '👤 Только тот, кто вызвал' : '👥 Разрешить всем',
                `settings_buttons_${mode === 'all' ? 'owner' : 'all'}`
            )
        ]);
    }
    lines.push(`⌨️ Нижнее меню: <b>${menuOn ? 'включено' : 'выключено'}</b>`);
    rows.push([
        Markup.button.callback(
            menuOn ? '⌨️ Выключить нижнее меню' : '⌨️ Включить нижнее меню',
            `settings_menu_${menuOn ? 'off' : 'on'}`
        )
    ]);
    rows.push([Markup.button.callback('✖️ Закрыть', 'settings_close')]);

    if (group) lines.push('', '<i>Менять настройки могут только админы группы.</i>');
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
}

/** Turns the bottom menu on or off; says so with a message, as only a message can carry a keyboard. */
async function setMenu(ctx, on) {
    await ctx.state.chatData.update({ menu_enabled: on });
    if (on) await ctx.reply('Нижнее меню включено.', mainMenu(ctx));
    else await ctx.reply('Нижнее меню выключено. Команды: /search, /subs, /settings, /help', Markup.removeKeyboard());
}

const NOT_ADMIN = 'Менять настройки группы могут только её админы.';

function register(bot) {
    const showSettings = async (ctx) => {
        if (!ctx.state.chatData) return;
        const view = settingsView(ctx.chat, ctx.state.chatData);
        await ctx.replyWithHTML(view.text, view.keyboard);
    };
    bot.command('settings', showSettings);
    bot.hears('⚙️ Настройки', showSettings);

    bot.action(/^settings_(buttons_owner|buttons_all|menu_on|menu_off)$/, async (ctx) => {
        if (!(await canChange(ctx))) return ctx.answerCbQuery(NOT_ADMIN, { show_alert: true });
        const [what, value] = ctx.match[1].split('_');
        if (what === 'buttons') {
            await ctx.state.chatData.update({ buttons_mode: value });
            await ctx.answerCbQuery(value === 'all' ? 'Теперь кнопки нажимают все' : 'Теперь только тот, кто вызвал');
        } else {
            await ctx.answerCbQuery();
            await setMenu(ctx, value === 'on');
        }
        const view = settingsView(ctx.chat, ctx.state.chatData);
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard }).catch(() => {});
    });

    // Whoever opened the screen closes it, or an admin; a member can't remove someone else's
    bot.action('settings_close', async (ctx) => {
        const opener = ownerOf(ctx.chat.id, ctx.callbackQuery.message.message_id);
        if (isGroup(ctx.chat) && opener !== ctx.from.id && !(await canChange(ctx))) {
            return ctx.answerCbQuery('Закрыть могут тот, кто открыл настройки, или админы.', { show_alert: true });
        }
        await ctx.answerCbQuery();
        await ctx.deleteMessage().catch(() => {});
    });

    // The old commands stay, with the same rule as the settings screen
    bot.command('menu_off', async (ctx) => {
        if (!ctx.state.chatData) return;
        if (!(await canChange(ctx))) return ctx.reply(NOT_ADMIN);
        await setMenu(ctx, false);
    });
    bot.command('menu_on', async (ctx) => {
        if (!ctx.state.chatData) return;
        if (!(await canChange(ctx))) return ctx.reply(NOT_ADMIN);
        await setMenu(ctx, true);
    });
}

module.exports = { register, settingsView, canChange };
