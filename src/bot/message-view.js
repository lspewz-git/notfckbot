/** Edit an HTML view in place; pressing the same page again is harmless. */
async function editView(ctx, { text, keyboard }, extra = {}) {
    try {
        return await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra, ...keyboard });
    } catch (err) {
        if (!String(err?.description || err?.message).includes('message is not modified')) throw err;
    }
}

module.exports = { editView };
