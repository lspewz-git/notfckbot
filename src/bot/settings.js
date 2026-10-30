/**
 * ⚙️ Settings: everything a chat can set about the bot, in one message. In a group anyone may
 * look, but only its admins may change things; in a private chat the user is the admin.
 */
const { Markup } = require('telegraf');
const { mainMenu } = require('./keyboards');
const { ownerOf } = require('./access');
const { ZONES, PRESETS, zoneOf, hasQuietHours, quietLabel, pad } = require('../quiet');
const { sentMarkOnEnable } = require('../cron/digests');
const { settingsOf } = require('../chat-ops');
const { recordSettings } = require('../chat-changes');
const events = require('../chat-events');

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
    lines.push(`🌙 Тихие часы: <b>${quietLabel(settings) || 'выключены'}</b>`);
    rows.push([Markup.button.callback('🌙 Тихие часы', 'settings_quiet')]);
    lines.push(`📅 Сводка недели: <b>${settings.digest_week ? 'по понедельникам в 10:00' : 'выключена'}</b>`);
    rows.push([
        Markup.button.callback(
            settings.digest_week ? '📅 Не присылать сводку недели' : '📅 Присылать сводку по понедельникам',
            `settings_digest_week_${settings.digest_week ? 'off' : 'on'}`
        )
    ]);
    lines.push(`🗓 Сводка месяца: <b>${settings.digest_month ? '1-го числа в 10:00' : 'выключена'}</b>`);
    rows.push([
        Markup.button.callback(
            settings.digest_month ? '🗓 Не присылать сводку месяца' : '🗓 Присылать сводку 1-го числа',
            `settings_digest_month_${settings.digest_month ? 'off' : 'on'}`
        )
    ]);
    rows.push([Markup.button.callback('✖️ Закрыть', 'settings_close')]);

    if (group) lines.push('', '<i>Менять настройки могут только админы группы.</i>');
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
}

/** The quiet hours screen: on or off, a few common choices, the time zone. */
function quietView(settings) {
    const on = hasQuietHours(settings);
    const zone = zoneOf(settings.timezone);
    const lines = [
        '🌙 <b>Тихие часы</b>',
        '',
        'Ночью уведомления не приходят: бот копит их и, когда тихие часы закончатся, присылает одним сообщением.',
        '',
        `Сейчас: <b>${on ? `${pad(settings.quiet_start)}–${pad(settings.quiet_end)}` : 'выключены'}</b>`,
        `Часовой пояс: <b>${zone.city} (UTC+${zone.offset})</b>`
    ];
    const presets = PRESETS.map(([start, end]) => {
        const current = on && settings.quiet_start === start && settings.quiet_end === end;
        return Markup.button.callback(
            `${current ? '✅ ' : ''}${pad(start)}–${pad(end)}`,
            `settings_quiet_${start}_${end}`
        );
    });
    const rows = [];
    if (on) rows.push([Markup.button.callback('Выключить', 'settings_quiet_off')]);
    for (let i = 0; i < presets.length; i += 2) rows.push(presets.slice(i, i + 2));
    rows.push([Markup.button.callback(`🕓 Часовой пояс: ${zone.city}`, 'settings_tz')]);
    rows.push([Markup.button.callback('⬅️ К настройкам', 'settings_open')]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
}

/** Russia's zones, two per row, the chat's ticked. */
function zoneView(settings) {
    const current = zoneOf(settings.timezone).id;
    const buttons = ZONES.map((z, i) =>
        Markup.button.callback(`${z.id === current ? '✅ ' : ''}${z.city} +${z.offset}`, `settings_tz_${i}`)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('⬅️ К тихим часам', 'settings_quiet')]);
    return {
        text: '🕓 <b>Часовой пояс</b>\n\nПо нему считаются тихие часы. Время указано относительно UTC.',
        keyboard: Markup.inlineKeyboard(rows)
    };
}

/** Puts a view in place of the settings message; an unchanged one is no error. */
const showView = (ctx, view) =>
    ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard }).catch((err) => {
        if (!/not modified/.test(err.message)) throw err;
    });

/** Applies a change from the buttons and notes it in the chat's change log (src/chat-changes.js). */
async function change(ctx, values) {
    const chat = ctx.state.chatData;
    const before = settingsOf(chat);
    await chat.update(values);
    recordSettings(ctx.chat.id, before, settingsOf(chat), events.actor(ctx));
}

/** Turns the bottom menu on or off; says so with a message, as only a message can carry a keyboard. */
async function setMenu(ctx, on) {
    await change(ctx, { menu_enabled: on });
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
            await change(ctx, { buttons_mode: value });
            await ctx.answerCbQuery(value === 'all' ? 'Теперь кнопки нажимают все' : 'Теперь только тот, кто вызвал');
        } else {
            await ctx.answerCbQuery();
            await setMenu(ctx, value === 'on');
        }
        const view = settingsView(ctx.chat, ctx.state.chatData);
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard }).catch(() => {});
    });

    // Quiet hours and the time zone: anyone may look, only admins change (in a group)
    bot.action('settings_open', async (ctx) => {
        await ctx.answerCbQuery();
        await showView(ctx, settingsView(ctx.chat, ctx.state.chatData));
    });
    bot.action('settings_quiet', async (ctx) => {
        await ctx.answerCbQuery();
        await showView(ctx, quietView(ctx.state.chatData));
    });
    bot.action('settings_tz', async (ctx) => {
        await ctx.answerCbQuery();
        await showView(ctx, zoneView(ctx.state.chatData));
    });
    bot.action(/^settings_quiet_(off|(\d{1,2})_(\d{1,2}))$/, async (ctx) => {
        if (!(await canChange(ctx))) return ctx.answerCbQuery(NOT_ADMIN, { show_alert: true });
        const off = ctx.match[1] === 'off';
        const start = Number(ctx.match[2]);
        const end = Number(ctx.match[3]);
        // Only the offered choices: callback data can be made up
        if (!off && !PRESETS.some(([s, e]) => s === start && e === end)) return ctx.answerCbQuery();
        await change(ctx, off ? { quiet_start: null, quiet_end: null } : { quiet_start: start, quiet_end: end });
        await ctx.answerCbQuery(off ? 'Тихие часы выключены' : `Тихие часы: ${pad(start)}–${pad(end)}`);
        await showView(ctx, quietView(ctx.state.chatData));
    });
    bot.action(/^settings_tz_(\d{1,2})$/, async (ctx) => {
        if (!(await canChange(ctx))) return ctx.answerCbQuery(NOT_ADMIN, { show_alert: true });
        const zone = ZONES[Number(ctx.match[1])];
        if (!zone) return ctx.answerCbQuery();
        await change(ctx, { timezone: zone.id });
        await ctx.answerCbQuery(`Часовой пояс: ${zone.city}`);
        await showView(ctx, quietView(ctx.state.chatData));
    });

    // The digests: on from the next one due (sentMarkOnEnable), off at once
    bot.action(/^settings_digest_(week|month)_(on|off)$/, async (ctx) => {
        if (!(await canChange(ctx))) return ctx.answerCbQuery(NOT_ADMIN, { show_alert: true });
        const [, which, state] = ctx.match;
        const on = state === 'on';
        const settings = ctx.state.chatData;
        await change(ctx, {
            [`digest_${which}`]: on,
            ...(on ? { [`digest_${which}_sent`]: sentMarkOnEnable(which === 'week' ? 'w' : 'm', settings) } : {})
        });
        const name = which === 'week' ? 'Сводка недели' : 'Сводка месяца';
        await ctx.answerCbQuery(`${name} ${on ? 'включена' : 'выключена'}`);
        await showView(ctx, settingsView(ctx.chat, settings));
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

module.exports = { register, settingsView, quietView, zoneView, canChange };
