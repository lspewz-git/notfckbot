/**
 * The bot token out of a text that is logged, stored or shown in the panel. Telegraf hides it in
 * its network errors, not in every other one (a proxy's page that isn't JSON, a parse error that
 * quotes the URL).
 */
function redactToken(text) {
    let out = String(text).replace(/bot\d+:[\w-]+/g, 'bot<token>');
    const token = process.env.BOT_TOKEN;
    if (token) out = out.split(token).join('<token>');
    return out;
}

module.exports = { redactToken };
