/**
 * The user's own chats inside the panel (src/account/routes.js): "My subscriptions", "Calendar" and
 * "Chat settings" for the chat picked at the top of each. Every signed-in user has these; an
 * admin has the rest of the panel too. In English like the panel (a language switch comes later).
 */
import { api } from './api.js';
import { $, escapeHtml, all } from './dom.js';
import { toast, openModal, closeModal } from './ui.js';
import { pickFrom } from './pick-sheet.js';
import { chatChip } from './chat-picker.js';

const POSTER = (path, size = 'w185') => (path ? `/api/poster/${size}${path}` : '');

import {
    MODES,
    modesField,
    searchResults,
    openSearchCard,
    cardClose,
    searchForm,
    titleRating,
    description
} from './content-search.js';
export { MODES };

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
    /** @type {{ id: string, type: string, title: string, settings: boolean, hidden?: boolean }[] | null} null until /api/account/chats answers */
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
    /** @type {any} */
    aired: null,
    airedYear: null,
    airedWhat: 'all',
    airedLimit: 20,
    query: '',
    /** @type {any[]} */
    results: [],
    searching: false
};

const filters = { 'my-subs': '', 'my-calendar': '', 'my-aired': '' };
const matchesTitle = (title, section) =>
    String(title || '')
        .toLocaleLowerCase()
        .includes(filters[section].trim().toLocaleLowerCase());
const noMatches = () => empty('No matching titles', 'Try another title or clear the search.');

function renderFiltered(section) {
    if (section === 'my-subs' && state.list && !searchOpen) $('my-subs-body').innerHTML = subsView();
    if (section === 'my-calendar' && state.cal) showCalendar();
    if (section === 'my-aired' && state.aired) $('my-aired-body').innerHTML = airedView();
}

function closeFilter(section) {
    filters[section] = '';
    const input = /** @type {HTMLInputElement} */ ($(`${section}-filter`));
    input.value = '';
    $(`${section}-search`).hidden = true;
    document
        .querySelector(`[data-action="mine-filter-toggle"][data-page="${section}"]`)
        .setAttribute('aria-expanded', 'false');
    renderFiltered(section);
}

const chatPath = (rest) => `/account/chats/${encodeURIComponent(state.chatId)}${rest}`;

/**
 * The chats from /api/account/chats. Opens on the user's own account (first in the list), not on
 * the chat picked last time; only a sign-in link made in a group (`preferred`) opens that group.
 */
export function setChats(chats, preferred = null) {
    state.chats = chats;
    const ids = chats.filter((c) => !c.hidden).map((c) => c.id);
    state.chatId = preferred && ids.includes(String(preferred)) ? String(preferred) : ids[0] || null;
    state.chatsError = null;
    state.list = null;
    state.cal = null;
    resetAired();
    for (const section of Object.keys(filters)) closeFilter(section);
    showChatChips();
    reload();
}

const CHEVRON_RIGHT =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#chevron-right" /></svg>';

export const chatHint = (c) =>
    c.type === 'private' ? 'Private chat' : c.settings ? "Group · you're an admin" : 'Group · view only';

/** Show the stable account choice while the new session's chats are loading. */
export function resetChatChoice() {
    state.chats = null;
    state.chatId = null;
    showChatChips();
}

/** The chats and the open one, for the profile menu (profile.js) */
export const chatList = () => ({ chats: state.chats || [], chatId: state.chatId });

/** Apply a saved preference; hiding the current group returns to the first visible chat. */
export async function setChatHidden(id, hidden) {
    const chat = (state.chats || []).find((c) => c.id === id);
    if (!chat || chat.type === 'private') return;
    chat.hidden = hidden;
    if ((hidden && state.chatId === id) || (!hidden && !state.chatId)) {
        await selectChat((state.chats || []).find((c) => !c.hidden)?.id || null);
    }
}

/**
 * The chat at the top of each section: a small chip that opens the profile menu (profile.js) with
 * the chats, the settings and Sign out. Without a chat yet (loading, failed) it shows My account,
 * so signing out is always in reach
 */
function showChatChips() {
    const chat = (state.chats || []).find((c) => c.id === state.chatId);
    const name = chat ? chat.title : 'My account';
    const html = chatChip({
        title: name,
        accent: !chat || chat.type === 'private',
        action: 'profile-open',
        label: chat ? `Profile and chat: ${name}` : 'Profile'
    });
    for (const holder of all('[data-chat-picker]')) holder.innerHTML = html;
    for (const holder of all('[data-profile-chat]')) holder.textContent = name;
}

/** Another chat picked: every section shows it, and the open one loads it */
export async function selectChat(id) {
    if (id === state.chatId) return;
    state.chatId = id;
    state.list = null;
    state.cal = null;
    cardVersion += 1;
    closeModal('mine-card-modal');
    for (const section of Object.keys(filters)) closeFilter(section);
    resetAired();
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

const poster = (path, cls = 'mine-poster', loading = 'lazy') =>
    path
        ? `<img class="${cls}" src="${escapeHtml(POSTER(path))}" alt="" loading="${loading}" decoding="async" />`
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
        const films = list.films.filter((f) => matchesTitle(f.title, 'my-subs'));
        body = films.length
            ? `<ul class="glass-card mine-rows">${films.map((f) => row('mine-film', f.id, poster(f.poster), f.title, filmNote(f), f.year)).join('')}</ul>`
            : filters['my-subs']
              ? noMatches()
              : empty('No films waiting', 'Find a film and add it: the bot writes when it comes out.');
    } else {
        const items = (tab === 'archive' ? archive : running).filter((s) => matchesTitle(s.title, 'my-subs'));
        body = items.length
            ? `<ul class="glass-card mine-rows">${items.map((s) => row('mine-series', s.id, poster(s.poster), s.title, seriesNote(s), MODES[s.mode]?.short)).join('')}</ul>`
            : filters['my-subs']
              ? noMatches()
              : tab === 'archive'
                ? empty('No ended series', 'Series that have ended go here. If one is renewed, the bot writes.')
                : empty('No subscriptions yet', 'Find a series and subscribe to its new episodes.');
    }
    return top + body;
}

function searchView() {
    return (
        searchForm({ context: 'account', inputId: 'mine-q', query: state.query, back: 'mine-search-close' }) +
        '<div id="mine-results"></div>'
    );
}

function resultsView() {
    return searchResults(state.results, {
        open: 'mine-search-card',
        series: 'mine-pick-series',
        film: 'mine-add-film'
    });
}

// --- The card ---

// The 'info' link is Kinopoisk's page: its logo and an out arrow, as in the panel's History
const KP_LOGO = '<svg class="kp-logo" aria-hidden="true"><use href="#kp-logo-symbol" /></svg>';
const OUT_ARROW =
    '<svg class="icon kp-out" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#arrow-up-right" /></svg>';

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

const cardHead = (picture, title, lines, rating = '') =>
    `<div class="mine-card-head">${picture}<div><h3 id="mine-card-title">${escapeHtml(title)}</h3>${lines
        .filter(Boolean)
        .map((l) => `<p class="mine-dim">${escapeHtml(l)}</p>`)
        .join('')}${rating}</div></div>`;

const CLOSE_X = cardClose('mine-card-modal');

/** Following, Calendar and Released share the complete card and spacing. */
function followingCard(item, { event = null, today, confirm = false, releasedYear = null }) {
    const released = releasedYear !== null;
    const busy =
        pendingModeSaves.has(titleKey(item, state.chatId)) || pendingUnfollows.has(titleKey(item, state.chatId));
    const tv = item.kind === 'tv';
    const date = event?.date || (tv ? item.next?.date : item.date);
    const release =
        released && tv
            ? (item.seasonPremieres || [])
                  .map(
                      (s) =>
                          `<p class="mine-dim">Season ${escapeHtml(s.season)} premiere · ${escapeHtml(dateText(s.date, { withYear: true }) || 'TBA')}</p>`
                  )
                  .join('') ||
              `<p class="mine-dim">No season premiere listed in ${escapeHtml(String(releasedYear))}</p>`
            : date
              ? `<div class="mine-release-date"><time datetime="${escapeHtml(date)}">${escapeHtml(dateText(date, { withYear: true }))}</time>${today ? `<span class="mine-release-count">${escapeHtml(whenText(date, today))}</span>` : ''}</div>`
              : `<p class="mine-dim">${released ? escapeHtml(String(releasedYear)) : 'Release date not known yet'}</p>`;
    const lines = tv
        ? [
              released
                  ? (item.seasons || []).map((season) => `Season ${season}`).join(', ')
                  : event
                    ? `S${event.season}E${event.episode} · ${episodeName(event)}`
                    : item.finished
                      ? 'The series has ended'
                      : item.next
                        ? `Next: S${item.next.season}E${item.next.episode}`
                        : 'Next episode date unknown',
              event && MARKS[event.mark] ? MARKS[event.mark][0].toUpperCase() + MARKS[event.mark].slice(1) : '',
              [item.genres, item.networks].filter(Boolean).join(' · ')
          ]
        : ['Film · digital release', item.genres];
    const secondaryDates = !tv
        ? [
              item.ruPremiere ? `In Russian cinemas: ${dateText(item.ruPremiere, { withYear: true })}` : '',
              item.ruDigital ? `Online in Russia: ${dateText(item.ruDigital, { withYear: true })}` : ''
          ]
              .filter(Boolean)
              .map((text) => `<p class="mine-dim mine-card-note">${escapeHtml(text)}</p>`)
              .join('')
        : '';
    return (
        '<div class="mine-following-card">' +
        cardHead(
            poster(item.poster, 'mine-poster mine-poster-big', 'eager'),
            item.title,
            lines,
            titleRating(item.rating) + release
        ) +
        secondaryDates +
        (item.overview ? `<p class="mine-overview">${description(item.overview)}</p>` : '') +
        (!released && !event && tv && item.mode ? modesField('mine-mode', item.mode, item.id, busy) : '') +
        (!released && !tv
            ? '<p class="mine-dim mine-card-note">When the film is out, the bot sends links to watch it.</p>'
            : '') +
        `<div class="mine-card-actions">${linkButtons(item.links || [])}${
            released || item.id == null
                ? ''
                : confirm
                  ? `<div class="mine-confirm"><p>Unfollow “${escapeHtml(item.title)}”?</p><p>It will leave this chat’s following list and calendar. Release notifications will stop.</p><div class="modal-actions"><button type="button" class="btn btn-danger btn-grow" data-action="mine-confirm-unfollow"${busy ? ' disabled' : ''}>Yes, unfollow</button><button type="button" class="btn btn-ghost" data-action="mine-keep-following">Keep following</button></div></div>`
                  : `<button type="button" class="btn btn-danger-quiet btn-block" data-action="mine-ask-unfollow"${busy ? ' disabled' : ''}>Unfollow</button>`
        }</div></div>`
    );
}

let activeFollowing = null;
const pendingUnfollows = new Set();
const pendingModeSaves = new Set();
const titleKey = (item, chatId) => `${chatId}:${item.kind}:${item.id}`;

function syncFollowingBusy(item, chatId) {
    const key = titleKey(item, chatId);
    if (!activeFollowing || titleKey(activeFollowing.item, activeFollowing.chatId) !== key) return;
    const busy = pendingModeSaves.has(key) || pendingUnfollows.has(key);
    for (const control of all(
        '#mine-card-body .mine-modes, #mine-card-body [data-action="mine-ask-unfollow"], #mine-card-body [data-action="mine-confirm-unfollow"]'
    )) {
        /** @type {HTMLFieldSetElement | HTMLButtonElement} */ (control).disabled = busy;
    }
}

function openFollowing(item, options = {}) {
    const context = { item, event: null, today: state.list?.today, ...options, chatId: state.chatId };
    openCard(followingCard(item, context));
    activeFollowing = context;
}

function openNewCard(r) {
    activeFollowing = null;
    cardVersion += 1;
    searchCardId = r.tmdbId;
    openSearchCard(r, {
        modeName: 'mine-new-mode',
        submit: r.kind === 'tv' ? 'mine-subscribe' : 'mine-add-film',
        modal: 'mine-card-modal',
        bodyId: 'mine-card-body'
    });
}

/** The episode's title, or "Episode 8" while TMDB has none (in the panel's language) */
const episodeName = (item) => item.name || `Episode ${item.episode}`;

/** An episode or a film from the calendar */
function releaseCard(item, today) {
    openFollowing(
        {
            ...item,
            id: item.kind === 'tv' ? item.tmdbId : item.listId,
            links:
                item.links || (item.kinopoiskUrl ? [{ kind: 'info', label: 'Kinopoisk', url: item.kinopoiskUrl }] : [])
        },
        { event: item.kind === 'tv' ? item : null, today }
    );
}

function openCard(html, tmdbId = null) {
    activeFollowing = null;
    cardVersion += 1;
    searchCardId = tmdbId;
    $('mine-card-body').innerHTML = html + CLOSE_X;
    openModal('mine-card-modal');
}

let cardVersion = 0;
let searchCardId = null;
let searchRequest = 0;
const pendingAdds = new Set();

// --- Aired: the same chat-scoped yearly history as the bot ---

let airedRequest = 0;

function resetAired() {
    airedRequest += 1;
    state.aired = null;
    state.airedYear = null;
    state.airedLimit = 20;
    const body = $('my-aired-body');
    if (body) body.innerHTML = loading();
}

const airedItems = () =>
    state.aired
        ? [
              ...state.aired.series.map((i) => ({ ...i, kind: 'tv' })),
              ...state.aired.films.map((i) => ({ ...i, kind: 'movie' }))
          ]
        : [];

const airedNote = (item) =>
    [
        item.kind === 'tv' ? (item.seasons || []).map((s) => `Season ${s}`).join(', ') : 'Digital release',
        (item.genres || []).join(', ')
    ]
        .filter(Boolean)
        .join(' · ');

function airedView() {
    const data = state.aired;
    if (!data) return loading();
    const items = airedItems()
        .map((item, index) => ({ item, index }))
        .filter(
            ({ item }) =>
                matchesTitle(item.title, 'my-aired') &&
                (state.airedWhat === 'all' || (item.kind === 'tv' ? 'series' : 'films') === state.airedWhat)
        );
    return (
        (data.years.length
            ? tabs(
                  data.years.map((y) => [String(y), String(y)]),
                  String(data.year),
                  'mine-aired-year',
                  'year'
              )
            : '') +
        '<div class="mine-toolbar">' +
        tabs(
            [
                ['all', 'All'],
                ['series', 'Series'],
                ['films', 'Films']
            ],
            state.airedWhat,
            'mine-aired-what',
            'what'
        ) +
        '</div>' +
        (items.length
            ? '<ul class="glass-card mine-rows">' +
              items
                  .slice(0, state.airedLimit)
                  .map(({ item, index }) =>
                      row('mine-aired-item', String(index), poster(item.poster), item.title, airedNote(item), '')
                  )
                  .join('') +
              '</ul>'
            : filters['my-aired']
              ? noMatches()
              : empty(
                    'No releases yet',
                    data.year
                        ? `No releases in this category in ${data.year}.`
                        : 'No releases among this chat’s subscriptions in the last three years.'
                )) +
        (items.length > state.airedLimit
            ? '<button type="button" class="btn btn-outline" data-action="mine-aired-more">Show more</button>'
            : '')
    );
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
        .filter(
            ({ item }) =>
                calWhatOf(item.kind) === state.calWhat &&
                daysUntil(item.date, data.today) >= -1 &&
                matchesTitle(item.title, 'my-calendar')
        );
    if (!shown.length)
        return filters['my-calendar']
            ? noMatches()
            : state.calWhat === 'films'
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
        if (section === 'my-aired') {
            const request = ++airedRequest;
            if (!state.aired) body.innerHTML = loading();
            try {
                const data = await api(chatPath(`/aired${state.airedYear ? `?year=${state.airedYear}` : ''}`));
                if (stale() || request !== airedRequest) return;
                state.aired = data;
                state.airedYear = data.year;
                body.innerHTML = airedView();
            } catch (err) {
                if (stale() || request !== airedRequest) return;
                throw err;
            }
        } else if (section === 'my-subs') {
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
    'mine-filter-toggle': (el) => {
        const section = el.dataset.page;
        if (!Object.hasOwn(filters, section)) return;
        const holder = $(`${section}-search`);
        if (!holder.hidden) return closeFilter(section);
        holder.hidden = false;
        el.setAttribute('aria-expanded', 'true');
        $(`${section}-filter`).focus();
    },
    'mine-filter-close': (el) => {
        const section = el.dataset.page;
        closeFilter(section);
        /** @type {HTMLElement} */ (
            document.querySelector(`[data-action="mine-filter-toggle"][data-page="${section}"]`)
        ).focus();
    },
    'mine-aired-year': (el) => {
        state.airedYear = Number(el.dataset.year);
        state.airedLimit = 20;
        reload();
    },
    'mine-aired-what': (el) => {
        state.airedWhat = el.dataset.what;
        state.airedLimit = 20;
        $('my-aired-body').innerHTML = airedView();
    },
    'mine-aired-more': () => {
        state.airedLimit += 20;
        $('my-aired-body').innerHTML = airedView();
    },
    'mine-aired-item': (el) => {
        const item = airedItems()[Number(el.dataset.id)];
        if (item)
            openCard(
                followingCard(
                    {
                        ...item,
                        genres: (item.genres || []).join(', '),
                        links: item.links?.length
                            ? item.links
                            : [{ kind: 'info', label: 'Kinopoisk', url: item.kinopoiskUrl }]
                    },
                    { today: undefined, releasedYear: state.aired.year }
                )
            );
    },
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
        if (s) openFollowing({ ...s, kind: 'tv' });
    },
    'mine-film': (el) => {
        const f = findFilm(el.dataset.id);
        if (f) openFollowing({ ...f, kind: 'movie' });
    },
    'mine-ask-unfollow': () => {
        if (activeFollowing?.chatId !== state.chatId) return;
        if (pendingModeSaves.has(titleKey(activeFollowing.item, activeFollowing.chatId))) return;
        openFollowing(activeFollowing.item, { ...activeFollowing, confirm: true });
    },
    'mine-keep-following': () => {
        if (activeFollowing?.chatId !== state.chatId) return;
        openFollowing(activeFollowing.item, { ...activeFollowing, confirm: false });
    },
    'mine-confirm-unfollow': async (el) => {
        const context = activeFollowing;
        if (!context || context.chatId !== state.chatId || el.disabled) return;
        const { item, chatId } = context;
        const key = titleKey(item, chatId);
        if (pendingUnfollows.has(key) || pendingModeSaves.has(key)) return;
        pendingUnfollows.add(key);
        syncFollowingBusy(item, chatId);
        const cardNow = cardVersion;
        el.disabled = true;
        try {
            await api(
                `/account/chats/${encodeURIComponent(chatId)}/${item.kind === 'tv' ? 'series' : 'films'}/${encodeURIComponent(item.id)}`,
                { method: 'DELETE' }
            );
            if (state.chatId !== chatId) return;
            if (cardVersion === cardNow) closeModal('mine-card-modal');
            toast('No longer following', 'success');
            state.cal = null;
            state.list = null;
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            pendingUnfollows.delete(key);
            syncFollowingBusy(item, chatId);
        }
    },
    'mine-search-open': () => {
        closeFilter('my-subs');
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
    'mine-search-card': (el) => {
        const r = state.results.find((x) => x.tmdbId === el.dataset.id);
        if (r) openNewCard(r);
    },
    'mine-pick-series': (el) => {
        const r = state.results.find((x) => x.tmdbId === el.dataset.id);
        if (r) openNewCard(r);
    },
    'mine-subscribe': async (el) => {
        const chatNow = state.chatId;
        const cardNow = cardVersion;
        const key = `${chatNow}:${el.dataset.id}`;
        if (pendingAdds.has(key)) return;
        pendingAdds.add(key);
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
            toast('Subscribed', 'success');
            if (state.chatId !== chatNow) return;
            if (cardVersion === cardNow || searchCardId === el.dataset.id) closeModal('mine-card-modal');
            markAdded(el.dataset.id);
            state.list = null;
        } catch (err) {
            button.disabled = false;
            toast(err.message, 'error');
        } finally {
            pendingAdds.delete(key);
        }
    },
    'mine-add-film': async (el) => {
        const chatNow = state.chatId;
        const cardNow = cardVersion;
        const key = `${chatNow}:${el.dataset.id}`;
        if (pendingAdds.has(key)) return;
        pendingAdds.add(key);
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
            if (state.chatId !== chatNow) return;
            if (cardVersion === cardNow || searchCardId === el.dataset.id) closeModal('mine-card-modal');
            markAdded(el.dataset.id);
            state.list = null;
        } catch (err) {
            button.disabled = false;
            toast(err.message, 'error');
        } finally {
            pendingAdds.delete(key);
        }
    },
    'mine-cal-what': (el) => {
        state.calWhat = el.dataset.what === 'films' ? 'films' : 'series';
        showCalendar();
    },
    'mine-cal-item': (el) => {
        const item = state.cal && state.cal.items && state.cal.items[Number(el.dataset.index)];
        if (item) releaseCard(item, state.cal.today);
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
    document.addEventListener('input', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const section = input.dataset.mineFilter;
        if (!Object.hasOwn(filters, section)) return;
        filters[section] = input.value;
        state.airedLimit = 20;
        renderFiltered(section);
    });
    document.addEventListener('keydown', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (event.key === 'Escape' && Object.hasOwn(filters, input.dataset.mineFilter)) {
            event.preventDefault();
            accountActions['mine-filter-close']({ dataset: { page: input.dataset.mineFilter } });
        }
    });
    document.addEventListener('change', async (event) => {
        const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (event.target);
        const kind = el.dataset && el.dataset.mine;
        if (kind === 'mode') {
            const context = activeFollowing;
            const s =
                context?.item.kind === 'tv' && context.item.id === el.dataset.id
                    ? context.item
                    : findSeries(el.dataset.id);
            if (!s) return;
            const chatNow = state.chatId;
            const cardNow = cardVersion;
            const item = { ...s, kind: 'tv' };
            const key = titleKey(item, chatNow);
            if (pendingModeSaves.has(key) || pendingUnfollows.has(key)) return;
            pendingModeSaves.add(key);
            syncFollowingBusy(item, chatNow);
            try {
                await api(chatPath('/series'), { method: 'POST', body: { tmdbId: s.id, mode: el.value } });
                s.mode = el.value;
                if (state.chatId !== chatNow) return;
                const listed = findSeries(s.id);
                if (listed) listed.mode = el.value;
                if (state.cal) for (const item of state.cal.items) if (item.tmdbId === s.id) item.mode = el.value;
                if (activeFollowing && titleKey(activeFollowing.item, activeFollowing.chatId) === key) {
                    activeFollowing.item.mode = el.value;
                    for (const radio of all('#mine-card-body input[data-mine="mode"]')) {
                        /** @type {HTMLInputElement} */ (radio).checked =
                            /** @type {HTMLInputElement} */ (radio).value === el.value;
                    }
                }
                toast('Notifications changed', 'success');
                if (state.list && !searchOpen) $('my-subs-body').innerHTML = subsView();
            } catch (err) {
                toast(err.message, 'error');
                if (state.chatId === chatNow && context && cardVersion === cardNow) openFollowing(s, context);
            } finally {
                pendingModeSaves.delete(key);
                syncFollowingBusy(item, chatNow);
            }
        }
    });
}

/** Role-specific loading behind the shared search form. */
export async function searchAccount(query) {
    if (!query) {
        searchRequest += 1;
        state.query = '';
        state.results = [];
        if ($('mine-results')) $('mine-results').innerHTML = '';
        return;
    }
    state.query = query;
    const request = ++searchRequest;
    const chatNow = state.chatId;
    const results = $('mine-results');
    results.innerHTML = loading();
    try {
        const found = await api(chatPath(`/search?q=${encodeURIComponent(query)}`));
        if (request !== searchRequest || state.query !== query || state.chatId !== chatNow || !searchOpen) return;
        state.results = found;
        if ($('mine-results')) $('mine-results').innerHTML = resultsView();
    } catch (err) {
        if (request === searchRequest && state.chatId === chatNow && searchOpen)
            results.innerHTML = failed(err.message);
    }
}
