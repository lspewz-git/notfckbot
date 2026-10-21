/**
 * The shape of what the panel sends, checked with zod before a route touches it: a field of the
 * wrong type answers 400 with its message instead of failing halfway (or being stored as it is).
 * What only the server can judge (a token with its service, a proxy URL) stays in the routes.
 */
const { z } = require('zod');

/**
 * The parsed data, or null after answering 400 with the first problem's message.
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} data
 * @param {import('express').Response} res
 * @returns {T | null}
 */
function valid(schema, data, res) {
    const result = schema.safeParse(data === undefined ? {} : data);
    if (result.success) return result.data;
    res.status(400).json({ error: result.error.issues[0].message });
    return null;
}

/** A string or a number, as a string matching `pattern`; `message` for anything else. */
const idOf = (pattern, message) =>
    z
        .union([z.string(), z.number()], { error: message })
        .transform(String)
        .pipe(z.string().regex(pattern, { error: message }));

/** A Telegram chat id: digits, negative for groups and channels. */
const chatId = (message = 'Bad chat id') => idOf(/^-?\d{1,20}$/, message);

/** Text that isn't blank; kept as typed. */
const text = (message) => z.string({ error: message }).refine((s) => s.trim() !== '', { error: message });

module.exports = { z, valid, idOf, chatId, text };
