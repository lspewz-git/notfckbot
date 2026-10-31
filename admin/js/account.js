/**
 * The user's own chats inside the panel (src/account/routes.js): "My subscriptions", "Calendar" and
 * "Chat settings" for the chat picked at the top of each. Every signed-in user has these; an
 * admin has the rest of the panel too. In English like the panel (a language switch comes later).
 */
import { api } from './api.js';
import { $, escapeHtml, all } from './dom.js';
import { toast, openModal, closeModal } from './ui.js';
import { avatar, pickFrom } from './pick-sheet.js';

const POSTER = (path, size = 'w185') => (path ? `/api/poster/${size}${path}` : '');

export const MODES = {
    episode: { short: 'Every episode', long: 'Every episode' },
    first_and_full: { short: 'Ep. 1 + season', long: 'Episode 1 and the whole season' },
    season: { short: 'Season', long: 'When the whole season is out' }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-11-04" → "Nov 4" (with the year when it isn't this one, or asked) */
export function dateText(iso, { withYear = false } = {}) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    const text = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
    return withYear || Number(m[1]) !== new Date().getFullYear() ? `${text}, ${m[1]}` : text;
}

const weekday = (iso) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** Days from `today` to `day`, both "YYYY-MM-DD" in the chat's time zone */
const daysUntil = (day, today) =>
    Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);

function whenText(day, today) {
    const n = daysUntil(day, today);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

const MARKS = { premiere: 'season premiere', finale: 'season finale' };

const state = {
    /** @type {{ id: string, type: string, title: string, settings: boolean }[] | null} null until /api/account/chats answers */
    chats: null,
    /** @type {string | null} why the chats couldn't be loaded */
    chatsError: null,
    chatId: null,
    subsTab: 'series',
    /** @type {any} */
    list: null,
    /** @type {'series' | 'films'} */
    calWhat: 'series',
    /** @type {any} the calendar's last answer, for its cards */
    cal: null,
    query: '',
    /** @type {any[]} */
    results: [],
    searching: false
};

const chatPath = (rest) => `/account/chats/${encodeURIComponent(state.chatId)}${rest}`;

/**
 * The chats from /api/account/chats. Opens on the user's own account (first in the list), not on
 * the chat picked last time; only a sign-in link made in a group (`preferred`) opens that group.
 */
export function setChats(chats, preferred = null) {
    state.chats = chats;
    const ids = chats.map((c) => c.id);
    state.chatId = preferred && ids.includes(String(preferred)) ? String(preferred) : ids[0] || null;
    state.chatsError = null;
    state.list = null;
    state.cal = null;
    showChatChips();
    reload();
}

const CHEVRON_DOWN =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>';
const CHEVRON_RIGHT =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>';

export const chatHint = (c) =>
    c.type === 'private' ? 'Private chat' : c.settings ? "Group · you're an admin" : 'Group · view only';

/** The signed-in person's name: the chip shows it until the chats are there (session.js) */
let ownerName = '';

export function setOwnerName(name) {
    ownerName = name || '';
    showChatChips();
}

/** The chats and the open one, for the profile menu (profile.js) */
export const chatList = () => ({ chats: state.chats || [], chatId: state.chatId });

/**
 * The chat at the top of each section: a small chip that opens the profile menu (profile.js) with
 * the chats, the settings and Sign out. Without a chat yet (loading, failed) it shows the person,
 * so signing out is always in reach
 */
function showChatChips() {
    const chat = (state.chats || []).find((c) => c.id === state.chatId);
    const name = chat ? chat.title : ownerName || 'Account';
    const html =
        `<button type="button" class="mine-chat-chip" data-action="profile-open" aria-haspopup="dialog" aria-label="${chat ? `Profile and chat: ${escapeHtml(name)}` : 'Profile'}">` +
        `${avatar(name, !chat || chat.type === 'private')}<span class="mine-chat-chip-name">${escapeHtml(name)}</span>${CHEVRON_DOWN}</button>`;
    for (const holder of all('[data-chat-picker]')) holder.innerHTML = html;
}

/** Another chat picked: every section shows it, and the open one loads it */
export async function selectChat(id) {
    if (id === state.chatId) return;
    state.chatId = id;
    state.list = null;
    state.cal = null;
    searchOpen = false;
    // The search's "Added" marks belong to the chat it was made for
    state.query = '';
    state.results = [];
    // The other chat's settings rows would save their choices to this one while it loads
    settings = null;
    const sets = $('my-settings-body');
    if (sets && sets.querySelector('.mine-sets')) sets.innerHTML = loading();
    showChatChips();
    await reload();
}

/** The chats didn't load: the sections say so, with a retry. */
export function chatsFailed(message) {
    state.chatsError = message;
    reload();
}

// --- Pieces ---

const poster = (path, cls = 'mine-poster') =>
    path
        ? `<img class="${cls}" src="${escapeHtml(POSTER(path))}" alt="" loading="lazy" />`
        : `<span class="${cls} mine-poster-empty" aria-hidden="true"></span>`;

const empty = (title, body) =>
    `<div class="glass-card mine-empty"><p class="mine-empty-title">${escapeHtml(title)}</p><p class="mine-dim">${escapeHtml(body)}</p></div>`;

const loading = () => '<div class="glass-card mine-empty"><p class="mine-dim">Loading…</p></div>';

const failed = (message) =>
    '<div class="glass-card mine-empty"><p class="mine-empty-title">Failed to load</p>' +
    `<p class="mine-dim">${escapeHtml(message)}</p>` +
    '<button type="button" class="btn btn-outline" data-action="mine-reload">Retry</button></div>';

const tabs = (items, active, action, key) =>
    `<div class="tab-filters" role="group">${items
        .map(
            ([value, label]) =>
                `<button type="button" class="btn btn-ghost${value === active ? ' active' : ''}" aria-pressed="${value === active}" data-action="${action}" data-${key}="${value}">${label}</button>`
        )
        .join('')}</div>`;

const noChats = () =>
    empty(
        'No chats yet',
        'Send /start to the bot to get your own chat. Groups are the ones where both you and the bot are.'
    );

// --- Subscriptions ---

const seriesNote = (s) => {
    if (s.finished) return 'Ended';
    if (s.next) return `S${s.next.season}E${s.next.episode} · ${dateText(s.next.date)}`;
    return 'Next episode date unknown';
};

const filmNote = (f) =>
    [
        f.date ? `out ${dateText(f.date, { withYear: true })}` : 'release date unknown',
        f.ruPremiere ? `in Russian cinemas ${dateText(f.ruPremiere)}` : ''
    ]
        .filter(Boolean)
        .join(' · ');

const row = (action, id, picture, title, note, chip) =>
    `<li><button type="button" class="mine-row" data-action="${action}" data-id="${escapeHtml(id)}">${picture}` +
    `<span class="mine-row-text"><span class="mine-row-title">${escapeHtml(title)}</span><span class="mine-dim">${escapeHtml(note)}</span></span>` +
    `${chip ? `<span class="mine-chip">${escapeHtml(chip)}</span>` : ''}</button></li>`;

function subsView() {
    const list = state.list;
    const running = list.series.filter((s) => !s.finished);
    const archive = list.series.filter((s) => s.finished);
    const tab = state.subsTab;
    const top =
        '<div class="mine-toolbar">' +
        tabs(
            [
                ['series', `Series <span class="mine-count">${running.length}</span>`],
                ['films', `Films <span class="mine-count">${list.films.length}</span>`],
                ['archive', `Ended <span class="mine-count">${archive.length}</span>`]
            ],
            tab,
            'mine-subs-tab',
            'tab'
        ) +
        '<button type="button" class="btn btn-primary" data-action="mine-search-open">+ Add</button></div>';
    let body;
    if (tab === 'films') {
        body = list.films.length
            ? `<ul class="glass-card mine-rows">${list.films.map((f) => row('mine-film', f.id, poster(f.poster), f.title, filmNote(f), f.year)).join('')}</ul>`
            : empty('No films waiting', 'Find a film and add it: the bot writes when it comes out.');
    } else {
        const items = tab === 'archive' ? archive : running;
        body = items.length
            ? `<ul class="glass-card mine-rows">${items.map((s) => row('mine-series', s.id, poster(s.poster), s.title, seriesNote(s), MODES[s.mode]?.short)).join('')}</ul>`
            : tab === 'archive'
              ? empty('No ended series', 'Series that have ended go here. If one is renewed, the bot writes.')
              : empty('No subscriptions yet', 'Find a series and subscribe to its new episodes.');
    }
    return top + body;
}

function searchView() {
    return (
        '<form class="mine-search" data-mine="search">' +
        '<button type="button" class="btn btn-ghost" data-action="mine-search-close">← Back</button>' +
        `<input id="mine-q" class="input-field" type="search" name="q" placeholder="Series or film title" autocomplete="off" enterkeyhint="search" value="${escapeHtml(state.query)}" />` +
        '<button type="submit" class="btn btn-primary">Search</button></form><div id="mine-results"></div>'
    );
}

function resultsView() {
    if (!state.results.length) return empty('Nothing found', 'Try another spelling or the original title.');
    return `<ul class="glass-card mine-rows">${state.results
        .map((r) => {
            const note = [
                r.kind === 'tv' ? 'Series' : 'Film',
                r.year,
                r.kind === 'movie' && r.released ? 'already out' : ''
            ]
                .filter(Boolean)
                .join(' · ');
            const action = r.added
                ? '<span class="mine-chip">Added</span>'
                : r.kind === 'tv'
                  ? `<button type="button" class="btn btn-outline btn-compact" data-action="mine-pick-series" data-id="${escapeHtml(r.tmdbId)}">Subscribe</button>`
                  : `<button type="button" class="btn btn-outline btn-compact" data-action="mine-add-film" data-id="${escapeHtml(r.tmdbId)}">${r.released ? 'Add' : 'Wait for it'}</button>`;
            return `<li><div class="mine-row">${poster(r.poster)}<span class="mine-row-text"><span class="mine-row-title">${escapeHtml(r.title)}</span><span class="mine-dim">${escapeHtml(note)}</span></span>${action}</div></li>`;
        })
        .join('')}</ul>`;
}

// --- The card ---

// The 'info' link is Kinopoisk's page: its logo and an out arrow, as in the panel's History
const KP_LOGO = '<svg class="kp-logo" aria-hidden="true"><use href="#kp-logo-symbol" /></svg>';
const OUT_ARROW =
    '<svg class="icon kp-out" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>';

const linkButtons = (links) =>
    links.length
        ? `<div class="mine-links">${links
              .map((l) =>
                  l.kind === 'watch'
                      ? `<a class="btn btn-primary" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">▶ ${escapeHtml(l.label)}</a>`
                      : `<a class="btn btn-ghost" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${KP_LOGO}<span>${escapeHtml(l.label)}</span>${OUT_ARROW}</a>`
              )
              .join('')}</div>`
        : '';

const cardHead = (picture, title, lines) =>
    `<div class="mine-card-head">${picture}<div><h3 id="mine-card-title">${escapeHtml(title)}</h3>${lines
        .filter(Boolean)
        .map((l) => `<p class="mine-dim">${escapeHtml(l)}</p>`)
        .join('')}</div></div>`;

const modesField = (name, current, id) =>
    `<fieldset class="mine-modes"><legend class="field-label">Notify me</legend>${Object.entries(MODES)
        .map(
            ([key, m]) =>
                `<label class="mine-radio"><input type="radio" name="${name}" value="${key}"${id ? ` data-mine="mode" data-id="${escapeHtml(id)}"` : ''}${current === key ? ' checked' : ''} /> ${m.long}</label>`
        )
        .join('')}</fieldset>`;

const CLOSE_X =
    '<button type="button" data-close="mine-card-modal" class="modal-x" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>';

function seriesCard(s, { confirm = false } = {}) {
    return (
        cardHead(poster(s.poster, 'mine-poster mine-poster-big'), s.title, [
            [s.genres, s.networks].filter(Boolean).join(' · '),
            s.finished
                ? 'The series has ended'
                : s.next
                  ? `Next: S${s.next.season}E${s.next.episode}, ${dateText(s.next.date)}`
                  : 'Next episode date unknown',
            s.lastSeason ? `Last aired: S${s.lastSeason}E${s.lastEpisode}` : ''
        ]) +
        modesField('mine-mode', s.mode, s.id) +
        linkButtons(s.links) +
        (confirm
            ? `<div class="mine-confirm"><p>Unsubscribe from “${escapeHtml(s.title)}”?</p><div class="modal-actions"><button type="button" class="btn btn-danger btn-grow" data-action="mine-unsubscribe" data-id="${escapeHtml(s.id)}">Yes, unsubscribe</button><button type="button" class="btn btn-ghost" data-action="mine-series" data-id="${escapeHtml(s.id)}">No</button></div></div>`
            : `<button type="button" class="btn btn-danger-quiet btn-block" data-action="mine-ask-unsubscribe" data-id="${escapeHtml(s.id)}">Unsubscribe</button>`)
    );
}

function filmCard(f, { confirm = false } = {}) {
    return (
        cardHead(poster(f.poster, 'mine-poster mine-poster-big'), f.title, [
            f.genres,
            f.date ? `Out: ${dateText(f.date, { withYear: true })}` : 'Release date not known yet',
            f.ruPremiere ? `In Russian cinemas: ${dateText(f.ruPremiere, { withYear: true })}` : '',
            f.ruDigital ? `Online in Russia: ${dateText(f.ruDigital, { withYear: true })}` : ''
        ]) +
        '<p class="mine-dim">When the film is out, the bot sends links to watch it.</p>' +
        linkButtons(f.links) +
        (confirm
            ? `<div class="mine-confirm"><p>Remove “${escapeHtml(f.title)}” from the list?</p><div class="modal-actions"><button type="button" class="btn btn-danger btn-grow" data-action="mine-remove-film" data-id="${f.id}">Yes, remove</button><button type="button" class="btn btn-ghost" data-action="mine-film" data-id="${f.id}">No</button></div></div>`
            : `<button type="button" class="btn btn-danger-quiet btn-block" data-action="mine-ask-remove-film" data-id="${f.id}">Remove from the list</button>`)
    );
}

function newSeriesCard(r) {
    return (
        cardHead(poster(r.poster, 'mine-poster mine-poster-big'), r.title, ['Series', r.year]) +
        modesField('mine-new-mode', 'episode', null) +
        `<div class="modal-actions"><button type="button" class="btn btn-primary btn-grow" data-action="mine-subscribe" data-id="${escapeHtml(r.tmdbId)}">Subscribe</button>` +
        '<button type="button" class="btn btn-ghost" data-close="mine-card-modal">Cancel</button></div>'
    );
}

/** The episode's title, or "Episode 8" while TMDB has none (in the panel's language) */
const episodeName = (item) => item.name || `Episode ${item.episode}`;

const kinopoiskLink = (url) => (url ? linkButtons([{ kind: 'info', label: 'Kinopoisk', url }]) : '');

/** An episode or a film from the calendar */
function releaseCard(item, today) {
    const when = `${weekday(item.date)}, ${dateText(item.date, { withYear: true })} · ${whenText(item.date, today)}`;
    const lines =
        item.kind === 'tv'
            ? [
                  `S${item.season}E${item.episode} · ${episodeName(item)}`,
                  MARKS[item.mark] ? MARKS[item.mark][0].toUpperCase() + MARKS[item.mark].slice(1) : '',
                  when
              ]
            : ['Film · digital release', when];
    return (
        cardHead(poster(item.poster, 'mine-poster mine-poster-big'), item.title, lines) +
        (item.overview ? `<p class="mine-overview">${escapeHtml(item.overview)}</p>` : '') +
        kinopoiskLink(item.kinopoiskUrl)
    );
}

function openCard(html) {
    $('mine-card-body').innerHTML = html + CLOSE_X;
    openModal('mine-card-modal');
}

// --- Calendar ---

const calWhatOf = (kind) => (kind === 'movie' ? 'films' : 'series');

function calRow(item, index, today) {
    const sub =
        item.kind === 'tv'
            ? [`S${item.season}E${item.episode}`, episodeName(item), MARKS[item.mark]].filter(Boolean).join(' · ')
            : 'Digital release';
    const n = daysUntil(item.date, today);
    return (
        `<li><button type="button" class="mine-row mine-cal-row" data-action="mine-cal-item" data-index="${index}">` +
        `<span class="mine-cal-date"><b>${item.date.slice(8, 10)}</b>${weekday(item.date)}</span>${poster(item.poster)}` +
        `<span class="mine-row-text"><span class="mine-row-title">${escapeHtml(item.title)}</span><span class="mine-dim mine-cal-sub">${escapeHtml(sub)}</span></span>` +
        `<span class="mine-cal-when${n === 0 ? ' today' : ''}">${whenText(item.date, today)}</span></button></li>`
    );
}

/** "2027-07" → "July 2027"; the year only when it isn't today's */
const monthTitle = (key, today) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleString('en', {
        month: 'long',
        timeZone: 'UTC',
        ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' })
    });

/** Yesterday and what is still to come, in one card by date, a month's name before its first row */
function daysBody(data) {
    const shown = data.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => calWhatOf(item.kind) === state.calWhat && daysUntil(item.date, data.today) >= -1);
    if (!shown.length)
        return state.calWhat === 'films'
            ? empty('No films coming', 'No films on the list have a release date yet.')
            : empty('No episodes coming', 'No subscribed series have dated episodes yet.');
    let month = '';
    const rows = shown.map(({ item, index }) => {
        const key = item.date.slice(0, 7);
        const head = key === month ? '' : `<li class="mine-cal-month">${monthTitle(key, data.today)}</li>`;
        month = key;
        return head + calRow(item, index, data.today);
    });
    return `<ul class="glass-card mine-rows">${rows.join('')}</ul>`;
}

/** One list from yesterday on */
function calendarView(data) {
    const body = !data ? loading() : daysBody(data);
    const note =
        data && data.failed && state.calWhat === 'series'
            ? `<p class="mine-dim">TMDB didn't answer for ${data.failed} series: their episodes may be missing here.</p>`
            : '';
    return (
        '<div class="mine-toolbar mine-cal-bar">' +
        tabs(
            [
                ['series', 'Series'],
                ['films', 'Films']
            ],
            state.calWhat,
            'mine-cal-what',
            'what'
        ) +
        '</div>' +
        body +
        note
    );
}

// --- Settings ---

const pad = (h) => `${String(h).padStart(2, '0')}:00`;

/** The settings chosen from a list, with their choices and the current one (from /settings) */
function settingChoices(data) {
    const s = data.settings;
    const quiet = s.quiet_start === null || s.quiet_start === undefined ? 'off' : `${s.quiet_start}-${s.quiet_end}`;
    const presets = data.presets.map(([a, b]) => [`${a}-${b}`, `${pad(a)}–${pad(b)}`]);
    // A pair set elsewhere (the panel) that isn't a preset still shows
    if (quiet !== 'off' && !presets.some(([v]) => v === quiet)) {
        presets.push([quiet, `${pad(s.quiet_start)}–${pad(s.quiet_end)}`]);
    }
    return {
        quiet: { title: 'Quiet hours', value: quiet, options: [['off', 'Off'], ...presets] },
        timezone: {
            title: 'Time zone',
            value: s.timezone,
            options: data.zones.map((z) => [z.id, `${z.city} +${z.offset}`])
        },
        buttons_mode: {
            title: "Who presses the bot's buttons",
            value: s.buttons_mode,
            options: [
                ['owner', 'Whoever called them'],
                ['all', 'Every member']
            ]
        }
    };
}

/** The last /settings answer: the rows' sheets offer its choices */
let settings = null;

function settingsView(data) {
    settings = data;
    const s = data.settings;
    const choices = settingChoices(data);
    const off = data.canChange ? '' : ' disabled';
    // A row showing the current choice; it opens the list (pick-sheet.js)
    const pickRow = (name, label) => {
        const c = choices[name];
        const current = c.options.find(([v]) => String(v) === String(c.value));
        return (
            `<li><button type="button" class="mine-set mine-set-pick" data-action="mine-pick" data-name="${name}" aria-haspopup="dialog"${off}>` +
            `<span class="mine-set-text">${label}</span>` +
            `<span class="mine-set-value">${escapeHtml(current ? current[1] : '')}${CHEVRON_RIGHT}</span></button></li>`
        );
    };
    const toggleRow = (name, label, hint, on) =>
        `<li class="mine-set"><span class="mine-set-text"><span>${label}</span>${hint ? `<span class="mine-dim">${hint}</span>` : ''}</span>` +
        `<button type="button" class="switch" role="switch" aria-checked="${Boolean(on)}" aria-label="${label}" data-action="mine-toggle" data-name="${name}"${off}><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button></li>`;
    const group = (title, rows, note = '') =>
        `<section class="mine-group"><h3 class="mine-group-title">${title}</h3><ul class="glass-card mine-sets">${rows}</ul>` +
        (note ? `<p class="mine-group-note">${note}</p>` : '') +
        '</section>';
    return (
        (data.canChange
            ? ''
            : '<p class="mine-note">Only the group\'s admins change its settings. You can look at them.</p>') +
        group(
            'Notifications',
            pickRow('quiet', 'Quiet hours') + pickRow('timezone', 'Time zone'),
            'In quiet hours notifications wait and come in the morning as one message.'
        ) +
        group(
            'Digests',
            toggleRow('digest_week', 'Weekly', 'Mondays at 10:00', s.digest_week) +
                toggleRow('digest_month', 'Monthly', 'On the 1st at 10:00', s.digest_month)
        ) +
        group(
            'Bot',
            (data.group ? pickRow('buttons_mode', 'Buttons pressed by') : '') +
                toggleRow('menu_enabled', 'Bottom menu in the chat', '', s.menu_enabled !== false)
        )
    );
}

// --- Loading a section ---

let searchOpen = false;

/** Fills one of the three sections (data.js calls it like the panel's own loaders). */
export async function loadMine(section) {
    const body = $(`${section}-body`);
    if (!body) return;
    if (state.chatsError) {
        body.innerHTML = failed(state.chatsError);
        return;
    }
    if (!state.chats) {
        body.innerHTML = loading();
        return;
    }
    const chatNow = state.chatId;
    if (!chatNow) {
        body.innerHTML = noChats();
        return;
    }
    // Another chat picked meanwhile: this answer is old
    const stale = () => state.chatId !== chatNow;
    try {
        if (section === 'my-subs') {
            if (searchOpen) {
                if (!body.querySelector('#mine-q')) {
                    body.innerHTML = searchView();
                    if (state.query) $('mine-results').innerHTML = resultsView();
                }
                return;
            }
            if (!state.list) body.innerHTML = loading();
            const list = await api(chatPath('/list'));
            if (stale()) return;
            state.list = list;
            body.innerHTML = subsView();
        } else if (section === 'my-calendar') {
            if (!body.querySelector('.mine-cal-bar')) body.innerHTML = calendarView(null);
            const data = await api(chatPath('/calendar'));
            if (stale()) return;
            state.cal = data;
            body.innerHTML = calendarView(data);
        } else if (section === 'my-settings') {
            if (!body.querySelector('.mine-sets')) body.innerHTML = loading();
            const data = await api(chatPath('/settings'));
            if (stale()) return;
            body.innerHTML = settingsView(data);
        }
    } catch (err) {
        if (!stale()) body.innerHTML = failed(err.message);
        throw err;
    }
}

const visibleSection = () => {
    const open = document.querySelector('.mine-section.active');
    return open ? open.id.replace(/-section$/, '') : null;
};

const reload = () => {
    const section = visibleSection();
    return section ? loadMine(section).catch(() => {}) : Promise.resolve();
};

const findSeries = (id) => state.list && state.list.series.find((s) => s.id === id);
const findFilm = (id) => state.list && state.list.films.find((f) => String(f.id) === String(id));

function markAdded(tmdbId) {
    const r = state.results.find((x) => x.tmdbId === tmdbId);
    if (r) r.added = true;
    const results = $('mine-results');
    if (results && state.query) results.innerHTML = resultsView();
}

async function changeSettings(body) {
    try {
        await api(chatPath('/settings'), { method: 'PATCH', body });
        toast('Saved', 'success');
    } catch (err) {
        toast(err.message, 'error');
    }
    await reload();
}

const showCalendar = () => {
    $('my-calendar-body').innerHTML = calendarView(state.cal);
};

/** Click handlers, merged into app.js's delegation like the other modules' */
export const accountActions = {
    'mine-reload': () => {
        state.list = null;
        if (!state.chatsError) {
            reload();
            return;
        }
        state.chatsError = null;
        state.chats = null;
        reload();
        api('/account/chats')
            .then((chats) => setChats(chats))
            .catch((err) => chatsFailed(err.message));
    },
    'mine-subs-tab': (el) => {
        state.subsTab = el.dataset.tab;
        if (state.list) $('my-subs-body').innerHTML = subsView();
    },
    'mine-series': (el) => {
        const s = findSeries(el.dataset.id);
        if (s) openCard(seriesCard(s));
    },
    'mine-film': (el) => {
        const f = findFilm(el.dataset.id);
        if (f) openCard(filmCard(f));
    },
    'mine-ask-unsubscribe': (el) => {
        const s = findSeries(el.dataset.id);
        if (s) openCard(seriesCard(s, { confirm: true }));
    },
    'mine-ask-remove-film': (el) => {
        const f = findFilm(el.dataset.id);
        if (f) openCard(filmCard(f, { confirm: true }));
    },
    'mine-unsubscribe': async (el) => {
        try {
            await api(chatPath(`/series/${encodeURIComponent(el.dataset.id)}`), { method: 'DELETE' });
            closeModal('mine-card-modal');
            toast('Unsubscribed', 'success');
            state.cal = null;
            // The subscriptions page refetches its list itself; elsewhere a card would find the old one
            if (visibleSection() !== 'my-subs') state.list = null;
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    },
    'mine-remove-film': async (el) => {
        try {
            await api(chatPath(`/films/${encodeURIComponent(el.dataset.id)}`), { method: 'DELETE' });
            closeModal('mine-card-modal');
            toast('Film removed from the list', 'success');
            state.cal = null;
            // The subscriptions page refetches its list itself; elsewhere a card would find the old one
            if (visibleSection() !== 'my-subs') state.list = null;
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    },
    'mine-search-open': () => {
        searchOpen = true;
        $('my-subs-body').innerHTML = searchView();
        if (state.query) $('mine-results').innerHTML = resultsView();
        $('mine-q').focus();
    },
    'mine-search-close': () => {
        searchOpen = false;
        state.query = '';
        state.results = [];
        reload();
    },
    'mine-pick-series': (el) => {
        const r = state.results.find((x) => x.tmdbId === el.dataset.id);
        if (r) openCard(newSeriesCard(r));
    },
    'mine-subscribe': async (el) => {
        const picked = /** @type {HTMLInputElement | null} */ (
            document.querySelector('input[name="mine-new-mode"]:checked')
        );
        const button = /** @type {HTMLButtonElement} */ (el);
        button.disabled = true;
        try {
            await api(chatPath('/series'), {
                method: 'POST',
                body: { tmdbId: el.dataset.id, mode: picked ? picked.value : 'episode' }
            });
            closeModal('mine-card-modal');
            toast('Subscribed', 'success');
            markAdded(el.dataset.id);
            state.list = null;
        } catch (err) {
            button.disabled = false;
            toast(err.message, 'error');
        }
    },
    'mine-add-film': async (el) => {
        const button = /** @type {HTMLButtonElement} */ (el);
        button.disabled = true;
        try {
            const { released } = await api(chatPath('/films'), { method: 'POST', body: { tmdbId: el.dataset.id } });
            toast(
                released
                    ? 'The film is already out: added to the released ones'
                    : 'The bot writes when the film is out',
                'success'
            );
            markAdded(el.dataset.id);
            state.list = null;
        } catch (err) {
            button.disabled = false;
            toast(err.message, 'error');
        }
    },
    'mine-cal-what': (el) => {
        state.calWhat = el.dataset.what === 'films' ? 'films' : 'series';
        showCalendar();
    },
    'mine-cal-item': (el) => {
        const item = state.cal && state.cal.items && state.cal.items[Number(el.dataset.index)];
        if (item) openCard(releaseCard(item, state.cal.today));
    },
    'mine-pick': (el) => {
        const name = el.dataset.name;
        const c = settings && settingChoices(settings)[name];
        if (!c) return;
        pickFrom({
            title: c.title,
            value: String(c.value),
            options: c.options.map(([value, label]) => ({ value, label })),
            onPick: (value) => {
                if (name !== 'quiet') return changeSettings({ [name]: value });
                const [start, end] = value === 'off' ? [null, null] : value.split('-').map(Number);
                return changeSettings({ quiet_start: start, quiet_end: end });
            }
        });
    },
    'mine-toggle': (el) => {
        const on = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', String(on));
        changeSettings({ [el.dataset.name]: on });
    }
};

/** The mode radios and the search form. */
export function setupAccount() {
    document.addEventListener('change', async (event) => {
        const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (event.target);
        const kind = el.dataset && el.dataset.mine;
        if (kind === 'mode') {
            const s = findSeries(el.dataset.id);
            if (!s) return;
            try {
                await api(chatPath('/series'), { method: 'POST', body: { tmdbId: s.id, mode: el.value } });
                s.mode = el.value;
                toast('Notifications changed', 'success');
                if (state.list && !searchOpen) $('my-subs-body').innerHTML = subsView();
            } catch (err) {
                toast(err.message, 'error');
                openCard(seriesCard(s));
            }
        }
    });

    document.addEventListener('submit', async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.dataset.mine !== 'search') return;
        event.preventDefault();
        const query = String(new FormData(form).get('q') || '').trim();
        if (!query) return;
        state.query = query;
        const chatNow = state.chatId;
        const results = $('mine-results');
        results.innerHTML = loading();
        try {
            const found = await api(chatPath(`/search?q=${encodeURIComponent(query)}`));
            if (state.query !== query || state.chatId !== chatNow) return;
            state.results = found;
            if ($('mine-results')) $('mine-results').innerHTML = resultsView();
        } catch (err) {
            results.innerHTML = failed(err.message);
        }
    });
}
