/**
 * Quiet hours: a chat may ask for no notifications at night. Hours are whole and in the chat's
 * own time zone (Russia's zones only); "23–8" runs over midnight, "0–9" doesn't. What comes up
 * in those hours is held and sent as one message when they end (src/cron/held.js).
 */

/** Russia's time zones, west to east: the IANA id, a city to recognise it by, the UTC offset. */
const ZONES = [
    { id: 'Europe/Kaliningrad', city: 'Калининград', en: 'Kaliningrad', offset: 2 },
    { id: 'Europe/Moscow', city: 'Москва', en: 'Moscow', offset: 3 },
    { id: 'Europe/Samara', city: 'Самара', en: 'Samara', offset: 4 },
    { id: 'Asia/Yekaterinburg', city: 'Екатеринбург', en: 'Yekaterinburg', offset: 5 },
    { id: 'Asia/Omsk', city: 'Омск', en: 'Omsk', offset: 6 },
    { id: 'Asia/Novosibirsk', city: 'Новосибирск', en: 'Novosibirsk', offset: 7 },
    { id: 'Asia/Irkutsk', city: 'Иркутск', en: 'Irkutsk', offset: 8 },
    { id: 'Asia/Yakutsk', city: 'Якутск', en: 'Yakutsk', offset: 9 },
    { id: 'Asia/Vladivostok', city: 'Владивосток', en: 'Vladivostok', offset: 10 },
    { id: 'Asia/Magadan', city: 'Магадан', en: 'Magadan', offset: 11 },
    { id: 'Asia/Kamchatka', city: 'Камчатка', en: 'Kamchatka', offset: 12 }
];
const DEFAULT_ZONE = 'Europe/Moscow';

/** The choices the bot offers as buttons: [start, end] hours. */
const PRESETS = [
    [23, 8],
    [0, 9],
    [22, 7],
    [1, 10]
];

const zoneOf = (id) => ZONES.find((z) => z.id === id) || ZONES.find((z) => z.id === DEFAULT_ZONE);
const isHour = (h) => Number.isInteger(h) && h >= 0 && h <= 23;

/** Whether a chat has quiet hours set at all (a start equal to the end is no hours). */
const hasQuietHours = (chat) =>
    Boolean(chat) && isHour(chat.quiet_start) && isHour(chat.quiet_end) && chat.quiet_start !== chat.quiet_end;

/** The hour (0–23) it is now in a time zone. */
function hourIn(zoneId, now = new Date()) {
    const text = new Intl.DateTimeFormat('en-GB', {
        timeZone: zoneOf(zoneId).id,
        hour: 'numeric',
        hourCycle: 'h23'
    }).format(now);
    return Number(text);
}

/** Whether it is quiet hours for this chat right now. */
function isQuietNow(chat, now = new Date()) {
    if (!hasQuietHours(chat)) return false;
    const hour = hourIn(chat.timezone, now);
    const { quiet_start: start, quiet_end: end } = chat;
    // 23–8 wraps past midnight: quiet from 23 to 24 and from 0 to 8
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const pad = (h) => `${String(h).padStart(2, '0')}:00`;

/** "23:00–08:00 (Москва)", or null when off. */
function quietLabel(chat, lang = 'ru') {
    if (!hasQuietHours(chat)) return null;
    const zone = zoneOf(chat.timezone);
    return `${pad(chat.quiet_start)}–${pad(chat.quiet_end)} (${lang === 'en' ? zone.en : zone.city})`;
}

module.exports = { ZONES, DEFAULT_ZONE, PRESETS, zoneOf, isHour, hasQuietHours, hourIn, isQuietNow, quietLabel, pad };
