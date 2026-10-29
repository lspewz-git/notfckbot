/**
 * What the bot can alert about, and when: the events by group, which are critical (the bot can't
 * do its job), and the shared rules kept in .env (ALERT_DOWN_MINUTES, ALERT_SEND_SHARE,
 * ALERT_REPEAT_HOURS, ALERT_FIXED), set from the panel's Settings → Alerts.
 */
const { writeEnv } = require('../admin/env');

// title: the event in the panel's log; label: its row in a person's dialog, under its group
const EVENTS = [
    { key: 'check_failed', group: 'check', critical: true, title: 'Update check failed', label: 'Failed' },
    {
        key: 'check_late',
        group: 'check',
        critical: true,
        title: "Update check didn't run",
        label: "Didn't run on time"
    },
    {
        key: 'check_errors',
        group: 'check',
        critical: false,
        title: 'Update check had errors',
        label: 'Finished with errors'
    },
    {
        key: 'telegram_down',
        group: 'services',
        critical: true,
        title: 'Telegram not answering',
        label: 'Telegram not answering'
    },
    { key: 'tmdb_down', group: 'services', critical: false, title: 'TMDB not answering', label: 'TMDB not answering' },
    {
        key: 'proxy_down',
        group: 'services',
        critical: false,
        title: 'Proxy not answering',
        label: 'Proxy not answering'
    },
    {
        key: 'kinopoisk_down',
        group: 'services',
        critical: false,
        title: 'Kinopoisk not answering',
        label: 'Kinopoisk not answering'
    },
    {
        key: 'kinopoisk_quota',
        group: 'services',
        critical: false,
        title: 'Kinopoisk quota used up',
        label: 'Kinopoisk daily quota used up'
    },
    {
        key: 'sending_failed',
        group: 'sending',
        critical: true,
        title: 'Messages not going out',
        label: 'Messages not going out'
    },
    {
        key: 'queue_growing',
        group: 'sending',
        critical: false,
        title: 'Unsent queue growing',
        label: 'Unsent queue keeps growing'
    },
    {
        key: 'recap_failed',
        group: 'sending',
        critical: false,
        title: 'Year recap not delivered',
        label: 'Year recap failed for a chat'
    },
    {
        key: 'restart_crash',
        group: 'bot',
        critical: true,
        title: 'Restarted after a crash',
        label: 'Restarted after a crash'
    },
    {
        key: 'restart',
        group: 'bot',
        critical: false,
        title: 'Restarted',
        label: 'Restarted from the panel or a deploy'
    },
    { key: 'low_memory', group: 'bot', critical: false, title: 'Low memory', label: 'Server running low on memory' }
];

const GROUPS = [
    { key: 'check', title: 'Update check' },
    { key: 'services', title: 'Services' },
    { key: 'sending', title: 'Sending' },
    { key: 'bot', title: 'Bot' }
];

const KEYS = EVENTS.map((e) => e.key);
const PRESETS = ['all', 'critical', 'custom'];
const isCritical = (key) => EVENTS.some((e) => e.key === key && e.critical);

/** The event keys a custom recipient chose, from the row's JSON; unknown keys are dropped. */
function eventsOf(row) {
    try {
        const list = JSON.parse(row.events || '[]');
        return Array.isArray(list) ? KEYS.filter((k) => list.includes(k)) : [];
    } catch {
        return [];
    }
}

/** Whether a recipient wants to hear about an event. */
function wants(row, key) {
    if (row.preset === 'all') return true;
    if (row.preset === 'custom') return eventsOf(row).includes(key);
    return isCritical(key);
}

// The choices the panel offers for each rule, and what .env holds without a value
const RULES = {
    downMinutes: { env: 'ALERT_DOWN_MINUTES', choices: [5, 10, 15, 30, 60], fallback: 10 },
    sendShare: { env: 'ALERT_SEND_SHARE', choices: ['any', 'quarter', 'half', 'all'], fallback: 'half' },
    // 0: once, never repeated while it stays broken
    repeatHours: { env: 'ALERT_REPEAT_HOURS', choices: [0, 1, 3, 6, 12, 24], fallback: 6 },
    fixed: { env: 'ALERT_FIXED', choices: [true, false], fallback: true }
};

/** A rule's value as .env has it, or its default when missing or not one of the choices. */
function ruleValue(name, env = process.env) {
    const { env: key, choices, fallback } = RULES[name];
    const raw = env[key];
    // The switch is kept as on / off, like RECAP_SCHEDULE
    if (typeof fallback === 'boolean') return raw === 'on' ? true : raw === 'off' ? false : fallback;
    const value = choices.find((c) => String(c) === raw);
    return value === undefined ? fallback : value;
}

/** { downMinutes, sendShare, repeatHours, fixed } */
function readRules(env = process.env) {
    return Object.fromEntries(Object.keys(RULES).map((name) => [name, ruleValue(name, env)]));
}

/** What is wrong with these rules, or null. Every rule must be given and be one of its choices. */
function problemWith(rules) {
    for (const [name, { choices }] of Object.entries(RULES)) {
        if (!choices.includes(rules[name])) return `${name}: pick one of ${choices.join(', ')}`;
    }
    return null;
}

/** Writes the rules to .env, and to this process at once. */
function saveRules(rules) {
    const changes = Object.fromEntries(
        Object.entries(RULES).map(([name, { env }]) => [
            env,
            typeof rules[name] === 'boolean' ? (rules[name] ? 'on' : 'off') : String(rules[name])
        ])
    );
    writeEnv(changes);
    Object.assign(process.env, changes);
}

/** Whether a check's sending went badly enough to alert, by the rule: failed of failed + sent. */
function sendingBad(sent, failed, share = ruleValue('sendShare')) {
    const total = sent + failed;
    if (!failed) return false;
    if (share === 'any') return true;
    if (share === 'all') return sent === 0;
    // A share of a handful: one message lost of two isn't "messages not going out"; none going is
    return (failed >= 2 || sent === 0) && failed / total >= (share === 'quarter' ? 0.25 : 0.5);
}

module.exports = {
    EVENTS,
    GROUPS,
    KEYS,
    PRESETS,
    RULES,
    eventsOf,
    wants,
    readRules,
    ruleValue,
    problemWith,
    saveRules,
    sendingBad
};
