const { createHmac, timingSafeEqual } = require('node:crypto');
const { URLSearchParams } = require('node:url');
const { z } = require('../admin/validate');

const MAX_AGE_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;
const telegramUser = z.object({
    id: z.number().int().positive(),
    username: z.string().max(64).optional(),
    first_name: z.string().max(256),
    last_name: z.string().max(256).optional()
});

/** Verifies the signed launch data before reading the Telegram identity from it. */
function miniAppUser(initData, token, now = Date.now()) {
    if (!token) return null;
    const fields = new URLSearchParams(initData);
    if (fields.size !== new Set(fields.keys()).size) return null;
    const hash = fields.get('hash') || '';
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const authDate = fields.get('auth_date') || '';
    if (!/^\d{1,12}$/.test(authDate)) return null;
    const age = Math.floor(now / 1000) - Number(authDate);
    if (age > MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) return null;

    fields.delete('hash');
    fields.sort();
    const lines = [];
    for (const [key, value] of fields) {
        if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(value)) return null;
        lines.push(`${key}=${value}`);
    }
    const check = lines.join('\n');
    const key = createHmac('sha256', 'WebAppData').update(token).digest();
    const expected = createHmac('sha256', key).update(check).digest();
    if (!timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return null;

    try {
        const user = telegramUser.parse(JSON.parse(fields.get('user') || 'null'));
        return {
            launchId: hash,
            expiresAt: new Date((Number(authDate) + MAX_AGE_SECONDS + 1) * 1000),
            userId: user.id,
            userName: user.username
                ? `@${user.username}`
                : [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 255) || null
        };
    } catch {
        return null;
    }
}

module.exports = { miniAppUser };
