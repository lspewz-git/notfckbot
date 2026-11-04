/** The same explicit confirmation for a Telegram link, QR or a verified password. */
const { Markup } = require('telegraf');
const { checkWord, deviceOf } = require('./auth');
const { placeLine } = require('./devices');
const { escapeHtml } = require('../constants');

function confirmation(code) {
    // Which browser asks, and where it is: like Apple's sign-in map, before the "Да"
    const device = deviceOf(code);
    const where = [device?.name, placeLine(device)].filter(Boolean).map(escapeHtml).join('\n');
    return {
        text:
            '🔐 <b>Войти в панель NotFckBot?</b>\n\n' +
            (where ? `${where}\n\n` : '') +
            `Проверочный код: <b>${checkWord(code)}</b>. ` +
            'Нажмите «Да», только если этот же код сейчас на вашей странице входа. ' +
            'Если вы не начинали вход, нажмите «Нет».',
        extra: {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Да, это я', `login_ok_${code}`)],
                [Markup.button.callback('✖️ Нет', `login_no_${code}`)]
            ])
        }
    };
}

module.exports = { confirmation };
