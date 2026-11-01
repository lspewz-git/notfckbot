/** The same explicit confirmation for a Telegram link, QR or a verified password. */
const { Markup } = require('telegraf');
const { checkWord } = require('./auth');

function confirmation(code) {
    return {
        text:
            `🔐 <b>Войти в панель NotFckBot?</b>\n\nПроверочный код: <b>${checkWord(code)}</b>. ` +
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
