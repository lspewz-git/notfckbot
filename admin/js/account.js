/**
 * The user's own chats inside the panel (src/account/routes.js): Calendar, Released, Following, the
 * title search and Chat settings for the chat picked with the chip at the top of each tab (the
 * redesign, 06.11). Every signed-in user has these; an admin has the rest of the panel too. In
 * English like the panel (a language switch comes later).
 */
import { api } from './api.js';
import { createHistory } from './history.js';
import { openReleasedDetails } from './records.js';
import { $, escapeHtml, all } from './dom.js';
import { toast, openModal, closeModal, showConfirm } from './ui.js';
import { pickFrom, avatar, initial } from './pick-sheet.js';
import { chatChip } from './chat-picker.js';
import { searchResults, openSearchCard, MODES } from './content-search.js';
import { titleCard, notifyField, watchButton, posterSrc, fitDescriptions, NOTIFY } from './title-card.js';
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

/** "in 6 days", "tomorrow", "today", "2 days ago": one grey line on every row */
function whenText(day, today) {
    const n = daysUntil(day, today);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? `in ${n} days` : `${-n} days ago`;
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
    query: '',
    /** @type {any[]} */
    results: [],
    /** @type {string | null} why the last search failed */
    searchError: null,
    searching: false
};

/** The signed-in person's name (profile.js): their private chat's avatar shows its first letter */
let ownName = '';

/** A chat's avatar: a group's own letter, the person's for their private chat ("My account") */
export const chatAvatar = (c) => (c.type === 'private' ? avatar(ownName || c.title, true) : avatar(c.title));

/** Who is signed in changed (session.js → profile.js): the chips' avatars follow */
export function setOwnName(name) {
    ownName = String(name || '');
    showChatChips();
}

const chatPath = (rest) => `/account/chats/${encodeURIComponent(state.chatId)}${rest}`;

/**
 * The chats from /api/account/chats. Opens on the user's own account (first in the list), not on
 * the chat picked last time; only a Mini App opened from a group (`preferred`) opens that group.
 */
export function setChats(chats, preferred = null) {
    state.chats = chats;
    const ids = chats.filter((c) => !c.hidden).map((c) => c.id);
    // A named chat opens even when hidden from the menu: hiding only tidies the list, access stays
    const named = preferred && chats.some((c) => c.id === String(preferred));
    state.chatId = named ? String(preferred) : ids[0] || null;
    state.chatsError = null;
    state.list = null;
    state.cal = null;
    resetAired();
    showChatChips();
    chatsChanged();
    reload();
}

/** The Account tab (profile.js) redraws itself when the chats arrive, fail or change */
const chatsChanged = () => document.dispatchEvent(new window.CustomEvent('account-chats'));

const ICON = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#${name}" /></svg>`;
const CHEVRON_RIGHT = ICON('chevron-right');

export const chatHint = (c) =>
    c.type === 'private' ? 'Private chat' : c.settings ? "Group · you're an admin" : 'Group · view only';

/** Show the stable account choice while the new session's chats are loading. */
export function resetChatChoice() {
    state.chats = null;
    state.chatId = null;
    showChatChips();
    chatsChanged();
}

/** The chats and the open one, for the Account tab (profile.js); `error` once they failed */
export const chatList = () => ({
    chats: state.chats || [],
    chatId: state.chatId,
    loading: !state.chats && !state.chatsError,
    error: state.chatsError
});

/** Apply a saved preference; hiding the current group returns to the first visible chat. */
export async function setChatHidden(id, hidden) {
    const chat = (state.chats || []).find((c) => c.id === id);
    if (!chat || chat.type === 'private') return;
    chat.hidden = hidden;
    if ((hidden && state.chatId === id) || (!hidden && !state.chatId)) {
        await selectChat((state.chats || []).find((c) => !c.hidden)?.id || null);
    }
    chatsChanged();
}

/**
 * The chat at the top of each tab: a chip with its avatar and name that opens the chats
 * (`chat-switch`). Without a chat yet (loading, failed) it shows My account
 */
function showChatChips() {
    const chat = (state.chats || []).find((c) => c.id === state.chatId);
    const name = chat ? chat.title : 'My account';
    const html = chatChip({
        title: name,
        accent: !chat || chat.type === 'private',
        action: 'chat-switch',
        label: `Current chat: ${name}. Switch chat`,
        letterOf: !chat || chat.type === 'private' ? ownName || name : name
    });
    for (const holder of all('[data-chat-picker]')) holder.innerHTML = html;
    for (const holder of all('[data-profile-chat]')) holder.textContent = name;
    showTabChat(chat);
}

/** The Account tab shows the open chat's avatar: a group's letter, else the person's own */
function showTabChat(chat) {
    const group = Boolean(chat && chat.type !== 'private');
    for (const el of all('[data-tab-chat-avatar]')) {
        el.hidden = !group;
        el.innerHTML = group ? avatar(chat.title) : '';
    }
    for (const el of all('.tab-profile [data-profile-avatar]')) el.hidden = group;
}

/** The chip's sheet: the visible chats (and the open one), the open one checked */
function openChatSwitch() {
    if (!state.chats || !state.chats.length) return;
    const chats = state.chats.filter((c) => !c.hidden || c.id === state.chatId);
    pickFrom({
        title: 'Chats',
        admin: !document.body.classList.contains('role-user'),
        value: String(state.chatId),
        options: chats.map((c) => ({
            value: c.id,
            label: c.title,
            hint: chatHint(c),
            avatar: chatAvatar(c)
        })),
        onPick: (id) => selectChat(id)
    });
}

/** Another chat picked: every section shows it, and the open one loads it */
export async function selectChat(id) {
    if (id === state.chatId) return;
    state.chatId = id;
    state.list = null;
    state.cal = null;
    cardVersion += 1;
    closeModal('mine-card-modal');
    resetAired();
    // The search's Following marks belong to the chat it was made for
    state.query = '';
    state.results = [];
    state.searchError = null;
    searchRequest += 1;
    // The other chat's settings rows would save their choices to this one while it loads
    settings = null;
    const sets = $('my-settings-body');
    if (sets && sets.querySelector('.group-list')) sets.innerHTML = loading();
    showChatChips();
    chatsChanged();
    await reload();
}

/** The chats didn't load: the sections say so, with a retry. */
export function chatsFailed(message) {
    state.chatsError = message;
    chatsChanged();
    reload();
}

// --- Pieces ---

const thumb = (path, cls = 'title-thumb') => {
    const src = posterSrc(path);
    return src
        ? `<img class="${cls}" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="${cls} title-thumb-empty" aria-hidden="true"></span>`;
};

/** EmptyState: an icon in a circle, a title, one line */
const empty = (title, body, iconName = 'bookmark') =>
    `<div class="empty-state"><span class="empty-icon">${ICON(iconName)}</span>` +
    `<p class="empty-title">${escapeHtml(title)}</p><p class="empty-text">${escapeHtml(body)}</p></div>`;

/** Rows the size of the real ones while the list loads */
const loading = (rows = 3) =>
    `<ul class="group-list title-list" aria-busy="true" aria-label="Loading">${'<li><div class="group-row title-row" aria-hidden="true"><span class="title-thumb skeleton"></span><span class="row-skeleton"><span class="skeleton"></span><span class="skeleton"></span></span></div></li>'.repeat(rows)}</ul>`;

const failed = (message) =>
    `<div class="empty-state" role="alert"><span class="empty-icon">${ICON('triangle-alert')}</span>` +
    `<p class="empty-title">Failed to load</p><p class="empty-text">${escapeHtml(message)}</p>` +
    '<button type="button" class="sheet-btn-secondary empty-action" data-action="mine-reload">Retry</button></div>';

/** CategoryChips: pills in 44px zones, the open one inverted; optional counts */
const chips = (items, active, action, key) =>
    `<div class="cat-chips" role="tablist">${items
        .map(
            ([value, label, count]) =>
                `<button type="button" class="cat-chip" role="tab" aria-selected="${value === active}" data-action="${action}" data-${key}="${value}">` +
                `<span>${label}${count === undefined ? '' : `<span class="cat-count">${count}</span>`}</span></button>`
        )
        .join('')}</div>`;

const FOLLOW_PLUS = `<a class="cat-plus" href="#my-search" data-action="mine-search-open" data-section="my-search" aria-label="Follow a title"><span>${ICON('plus')}</span></a>`;

const noChats = () =>
    empty(
        'No chats yet',
        'Send /start to the bot to get your own chat. Groups are the ones where both you and the bot are.',
        'users'
    );

/** A title in a list: poster, name, one line, an optional badge, the chevron */
const titleRow = ({ action, id, poster, title, note, badge = '' }) =>
    `<li><button type="button" class="group-row title-row" data-action="${action}" data-id="${escapeHtml(id)}">${thumb(poster)}` +
    `<span class="row-text"><span class="row-name">${escapeHtml(title)}</span><span class="row-meta">${escapeHtml(note)}</span></span>` +
    `${badge ? `<span class="row-badge">${escapeHtml(badge)}</span>` : ''}<span class="row-chevron">${CHEVRON_RIGHT}</span></button></li>`;

// --- Following ---

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

function subsView() {
    const list = state.list;
    const running = list.series.filter((s) => !s.finished);
    const archive = list.series.filter((s) => s.finished);
    const tab = state.subsTab;
    const top =
        '<div class="cat-bar">' +
        chips(
            [
                ['series', 'Series', running.length],
                ['films', 'Films', list.films.length],
                ['archive', 'Ended', archive.length]
            ],
            tab,
            'mine-subs-tab',
            'tab'
        ) +
        FOLLOW_PLUS +
        '</div>';
    let body;
    if (tab === 'films') {
        body = list.films.length
            ? `<ul class="group-list title-list">${list.films
                  .map((f) =>
                      titleRow({
                          action: 'mine-film',
                          id: f.id,
                          poster: f.poster,
                          title: f.title,
                          note: filmNote(f),
                          badge: f.year
                      })
                  )
                  .join('')}</ul>`
            : empty('No films waiting', 'Find a film and follow it: the bot writes when it comes out.', 'film');
    } else {
        const items = tab === 'archive' ? archive : running;
        body = items.length
            ? `<ul class="group-list title-list">${items
                  .map((s) =>
                      titleRow({
                          action: 'mine-series',
                          id: s.id,
                          poster: s.poster,
                          title: s.title,
                          note: seriesNote(s),
                          badge: MODES[s.mode]?.short
                      })
                  )
                  .join('')}</ul>`
            : tab === 'archive'
              ? empty('No ended series', 'Series that have ended go here. If one is renewed, the bot writes.', 'tv')
              : empty('No series yet', 'Find a series and follow its new episodes.', 'tv');
    }
    return top + body;
}

// --- The title card (Following and Calendar) ---

const CLOSE = 'mine-card-modal';

/** What the card's date block says: the next episode, the calendar's episode, a film's release */
function dateBlock(item, event, today) {
    if (event) {
        const when = today ? whenText(event.date, today) : '';
        const bell = Boolean(event.notifyOn);
        const note = bell && event.notifyOn !== event.date ? `The bot messages you on ${dateText(event.notifyOn)}` : '';
        if (event.kind === 'tv')
            return {
                label: `S${event.season}E${event.episode} · ${episodeName(event)}`,
                value: [dateText(event.date, { withYear: true }), MARKS[event.mark]].filter(Boolean).join(' · '),
                when,
                bell,
                note
            };
        return { label: 'Digital release', value: dateText(event.date, { withYear: true }), when, bell, note };
    }
    if (item.kind === 'tv') {
        if (item.finished) return { label: 'Status', value: 'The series has ended' };
        return item.next
            ? {
                  label: 'Next episode',
                  value: `S${item.next.season}E${item.next.episode} · ${dateText(item.next.date, { withYear: true })}`,
                  when: today ? whenText(item.next.date, today) : ''
              }
            : { label: 'Next episode', value: 'Date not known yet' };
    }
    const ru = [
        item.ruPremiere ? `In Russian cinemas ${dateText(item.ruPremiere, { withYear: true })}` : '',
        item.ruDigital ? `Online in Russia ${dateText(item.ruDigital, { withYear: true })}` : ''
    ]
        .filter(Boolean)
        .join(' · ');
    return item.date
        ? {
              label: 'Digital release',
              value: dateText(item.date, { withYear: true }),
              when: today ? whenText(item.date, today) : '',
              note: ru
          }
        : { label: 'Digital release', value: 'Date not known yet', note: ru };
}

/** Following and Calendar share their card: Notify me only from Following (the user, 02.11) */
function followingCard(item, { event = null, today }) {
    const key = titleKey(item, state.chatId);
    const busy = pendingModeSaves.has(key) || pendingUnfollows.has(key);
    const tv = item.kind === 'tv';
    const links = item.links || [];
    const kinopoiskUrl = links.find((l) => l.kind === 'info')?.url || item.kinopoiskUrl || null;
    const unfollow =
        item.id == null
            ? ''
            : `<button type="button" class="sheet-btn-danger-soft" data-action="mine-ask-unfollow"${busy ? ' disabled' : ''}>Unfollow</button>`;
    return titleCard(
        {
            kind: item.kind,
            title: item.title,
            poster: item.poster,
            seasons: item.seasons,
            year: item.year,
            rating: item.rating,
            genres: item.genres,
            networks: item.networks,
            overview: item.overview,
            kinopoiskUrl,
            date: dateBlock(item, event, today)
        },
        {
            close: CLOSE,
            notify:
                !event && tv && item.mode
                    ? notifyField({ name: 'mine-mode', current: item.mode, id: item.id, disabled: busy })
                    : '',
            extra: '<p class="sheet-error" id="mine-card-error" role="alert" hidden></p>',
            actions: watchButton(links) + unfollow
        }
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
    for (const control of all('#mine-card-body .mine-modes, #mine-card-body [data-action="mine-ask-unfollow"]')) {
        /** @type {HTMLFieldSetElement | HTMLButtonElement} */ (control).disabled = busy;
    }
    const unfollowButton = document.querySelector('#mine-card-body [data-action="mine-ask-unfollow"]');
    if (unfollowButton) {
        unfollowButton.toggleAttribute('aria-busy', pendingUnfollows.has(key));
        unfollowButton.textContent = pendingUnfollows.has(key) ? 'Unfollowing…' : 'Unfollow';
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
    openFollowing({ ...item, id: item.kind === 'tv' ? item.tmdbId : item.listId }, { event: item, today });
}

function openCard(html, tmdbId = null) {
    activeFollowing = null;
    cardVersion += 1;
    searchCardId = tmdbId;
    $('mine-card-modal').innerHTML =
        `<div class="modal-content modal-narrow sheet-content title-sheet" id="mine-card-body">${html}</div>`;
    openModal('mine-card-modal');
    fitDescriptions($('mine-card-modal'));
}

let cardVersion = 0;
let searchCardId = null;
let searchRequest = 0;
const pendingAdds = new Set();

/** Unfollow after the confirmation; a failure stays on the card, next to the button */
async function unfollow(context) {
    const { item, chatId } = context;
    const key = titleKey(item, chatId);
    if (pendingUnfollows.has(key) || pendingModeSaves.has(key)) return;
    pendingUnfollows.add(key);
    syncFollowingBusy(item, chatId);
    const cardNow = cardVersion;
    const error = $('mine-card-error');
    if (error) error.hidden = true;
    try {
        await api(
            `/account/chats/${encodeURIComponent(chatId)}/${item.kind === 'tv' ? 'series' : 'films'}/${encodeURIComponent(item.id)}`,
            { method: 'DELETE' }
        );
        if (state.chatId !== chatId) return;
        if (cardVersion === cardNow) closeModal('mine-card-modal');
        toast('Unfollowed', 'success');
        state.cal = null;
        state.list = null;
        await reload();
    } catch (err) {
        const shown = cardVersion === cardNow && $('mine-card-error');
        if (shown) {
            shown.textContent = err.message;
            shown.hidden = false;
        } else toast(err.message, 'error');
    } finally {
        pendingUnfollows.delete(key);
        syncFollowingBusy(item, chatId);
    }
}

// --- Released: the same view as the admin panel, scoped to the selected chat ---
let airedHistory = null;
function getAiredHistory() {
    return (airedHistory ||= createHistory({
        prefix: 'my-aired',
        fetchYear: (year) => api(chatPath('/aired' + (year ? '?year=' + year : ''))),
        openTitle: openReleasedDetails
    }));
}
function resetAired() {
    airedHistory?.reset();
    closeModal('released-modal');
    const body = $('my-aired-body');
    if (body) body.innerHTML = loading(6);
}

// --- Calendar ---

const calWhatOf = (kind) => (kind === 'movie' ? 'films' : 'series');

const BELL = `<span class="cal-bell" role="img" aria-label="The bot will message you about this" title="The bot will message you about this">${ICON('bell')}</span>`;

function calRow(item, index, today, sameDay) {
    const sub =
        item.kind === 'tv'
            ? [`S${item.season}E${item.episode}`, episodeName(item), MARKS[item.mark]].filter(Boolean).join(' · ')
            : 'Digital release';
    return (
        `<li${sameDay ? ' class="cal-same-day"' : ''}><button type="button" class="group-row cal-row" data-action="mine-cal-item" data-index="${index}">` +
        `<span class="cal-day"${sameDay ? ' aria-hidden="true"' : ''}><b>${item.date.slice(8, 10)}</b><span>${weekday(item.date)}</span></span>${thumb(item.poster, 'title-thumb cal-thumb')}` +
        `<span class="row-text"><span class="row-name">${escapeHtml(item.title)}</span><span class="row-meta">${escapeHtml(sub)}</span></span>` +
        `<span class="cal-when">${item.notifyOn ? BELL : ''}<span>${whenText(item.date, today)}</span></span></button></li>`
    );
}

/** "2027-07" → "July 2027"; the year only when it isn't today's */
const monthTitle = (key, today) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleString('en', {
        month: 'long',
        timeZone: 'UTC',
        ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' })
    });

/** Yesterday and what is still to come, a card per month, the day shown once for its rows */
function daysBody(data) {
    const shown = data.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => calWhatOf(item.kind) === state.calWhat && daysUntil(item.date, data.today) >= -1);
    if (!shown.length)
        return state.calWhat === 'films'
            ? empty('No films coming', 'No films on the list have a release date yet.', 'film')
            : empty('No episodes coming', 'No followed series have dated episodes yet.', 'calendar-days');
    const months = [];
    for (const entry of shown) {
        const key = entry.item.date.slice(0, 7);
        if (!months.length || months[months.length - 1].key !== key) months.push({ key, rows: [] });
        months[months.length - 1].rows.push(entry);
    }
    return months
        .map(
            ({ key, rows }) =>
                `<h2 class="group-title">${monthTitle(key, data.today)}</h2><ul class="group-list cal-list">${rows
                    .map(({ item, index }, i) =>
                        calRow(item, index, data.today, i > 0 && rows[i - 1].item.date === item.date)
                    )
                    .join('')}</ul>`
        )
        .join('');
}

/** One list from yesterday on */
function calendarView(data) {
    const body = !data ? loading(4) : daysBody(data);
    const note =
        data && data.failed && state.calWhat === 'series'
            ? `<p class="group-help">TMDB didn't answer for ${data.failed} series: their episodes may be missing here.</p>`
            : '';
    return (
        '<div class="cat-bar mine-cal-bar">' +
        chips(
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

// --- Search ---

/** The tab the search was opened from: its Back returns there */
let searchFrom = 'my-subs';
let searchTimer = 0;

function resultsView() {
    if (state.searchError) return failed(state.searchError);
    if (!state.query)
        return empty(
            'Find a series or film',
            'Type a title in any language. Follow it to get messages in the chosen chat.',
            'search'
        );
    if (state.searching) return loading(4);
    return searchResults(state.results, {
        open: 'mine-search-card',
        series: 'mine-pick-series',
        film: 'mine-add-film'
    });
}

const showResults = () => {
    const box = $('mine-results');
    if (box) box.innerHTML = resultsView();
};

function syncSearchField() {
    const input = /** @type {HTMLInputElement | null} */ ($('mine-q'));
    if (!input) return;
    if (input.value !== state.query && document.activeElement !== input) input.value = state.query;
    $('mine-q-clear').hidden = !input.value;
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
    const pickRow = (name, tile, label) => {
        const c = choices[name];
        const current = c.options.find(([v]) => String(v) === String(c.value));
        return (
            `<li><button type="button" class="group-row" data-action="mine-pick" data-name="${name}" aria-haspopup="dialog"${off}>` +
            `<span class="row-tile">${ICON(tile)}</span>` +
            `<span class="row-text"><span class="row-name">${label}</span></span>` +
            `<span class="row-value">${escapeHtml(current ? current[1] : '')}</span>` +
            `<span class="row-chevron">${CHEVRON_RIGHT}</span></button></li>`
        );
    };
    const toggleRow = (name, tile, label, hint, on) =>
        `<li><div class="group-row group-row-static"><span class="row-tile">${ICON(tile)}</span>` +
        `<span class="row-text"><span class="row-name">${label}</span>${hint ? `<span class="row-meta">${hint}</span>` : ''}</span>` +
        `<button type="button" class="switch" role="switch" aria-checked="${Boolean(on)}" aria-label="${label}" data-action="mine-toggle" data-name="${name}"${off}><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button></div></li>`;
    const group = (title, rows, help = '') =>
        `<h2 class="group-title">${title}</h2><ul class="group-list">${rows}</ul>` +
        (help ? `<p class="group-help">${help}</p>` : '');
    return (
        chatCard(data) +
        (data.canChange
            ? ''
            : '<p class="group-help chat-settings-note">You can look at the settings; the group’s admins change them.</p>') +
        group(
            'Notifications',
            pickRow('quiet', 'moon', 'Quiet hours') + pickRow('timezone', 'globe', 'Time zone'),
            'In quiet hours notifications wait and come in the morning as one message.'
        ) +
        group(
            'Digests',
            toggleRow('digest_week', 'calendar-days', 'Weekly', 'Mondays at 10:00', s.digest_week) +
                toggleRow('digest_month', 'calendar', 'Monthly', 'On the 1st at 10:00', s.digest_month)
        ) +
        group(
            'Bot',
            (data.group ? pickRow('buttons_mode', 'users', 'Buttons pressed by') : '') +
                toggleRow('menu_enabled', 'panel-bottom', 'Bottom menu in the chat', '', s.menu_enabled !== false)
        )
    );
}

/**
 * Whose settings these are: the chat's letter, name and kind, and whether the user may change them.
 * A tap opens the chats, as the chip on the tabs does
 */
function chatCard(data) {
    const chat = (state.chats || []).find((c) => c.id === state.chatId);
    const title = chat ? chat.title : 'My account';
    const group = Boolean(data.group);
    const meta = !group ? 'Your personal chat' : data.canChange ? 'You’re an admin' : 'Only admins change settings';
    return (
        `<button type="button" class="group-card chat-card" data-action="chat-switch" aria-haspopup="dialog" aria-label="Current chat: ${escapeHtml(title)}. Switch chat">` +
        `<span class="profile-avatar${group ? ' profile-avatar-group' : ''}" aria-hidden="true">${escapeHtml(initial(group ? title : ownName || title))}</span>` +
        `<span class="row-text"><span class="profile-name"><span class="card-name">${escapeHtml(title)}</span>` +
        `<span class="role-chip">${group ? 'Group' : 'Private'}</span></span>` +
        `<span class="row-meta">${meta}</span></span>` +
        `<span class="row-chevron">${ICON('chevrons-up-down')}</span></button>`
    );
}

// --- Loading a section ---

const SECTIONS = ['my-aired', 'my-subs', 'my-calendar', 'my-settings', 'my-search'];

/** Fills one of the sections (data.js calls it like the panel's own loaders). */
export async function loadMine(section) {
    if (!SECTIONS.includes(section)) return;
    if (section === 'my-search') {
        syncSearchField();
        if ($('mine-results') && !$('mine-results').firstChild) showResults();
        return;
    }
    const body = $(`${section}-body`);
    if (!body) return;
    if (state.chatsError) {
        body.innerHTML = failed(state.chatsError);
        return;
    }
    if (!state.chats) {
        body.innerHTML = section === 'my-settings' ? loading(2) : loading();
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
            await getAiredHistory().load();
        } else if (section === 'my-subs') {
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
            if (!body.querySelector('.group-list')) body.innerHTML = loading(2);
            const data = await api(chatPath('/settings'));
            if (stale()) return;
            body.innerHTML = settingsView(data);
        }
    } catch (err) {
        if (!stale() && section !== 'my-aired') body.innerHTML = failed(err.message);
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
    if (state.query) showResults();
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

/** Adds a title from the search; the button is busy until the answer, the sheet closes on success */
async function addTitle(el, path, body, done) {
    const chatNow = state.chatId;
    const cardNow = cardVersion;
    const key = `${chatNow}:${el.dataset.id}`;
    if (pendingAdds.has(key)) return;
    pendingAdds.add(key);
    const button = /** @type {HTMLButtonElement} */ (el);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
        const answer = await api(chatPath(path), { method: 'POST', body });
        toast(done(answer), 'success');
        if (state.chatId !== chatNow) return;
        if (cardVersion === cardNow || searchCardId === el.dataset.id) closeModal('mine-card-modal');
        markAdded(el.dataset.id);
        state.list = null;
    } catch (err) {
        button.disabled = false;
        toast(err.message, 'error');
    } finally {
        pendingAdds.delete(key);
        button.removeAttribute('aria-busy');
    }
}

/** Click handlers, merged into app.js's delegation like the other modules' */
export const accountActions = {
    'chat-switch': openChatSwitch,
    'mine-reload': () => {
        state.list = null;
        if (!state.chatsError) {
            reload();
            return;
        }
        state.chatsError = null;
        state.chats = null;
        chatsChanged();
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
    'mine-ask-unfollow': (el) => {
        const context = activeFollowing;
        if (!context || context.chatId !== state.chatId || /** @type {HTMLButtonElement} */ (el).disabled) return;
        const key = titleKey(context.item, context.chatId);
        if (pendingModeSaves.has(key) || pendingUnfollows.has(key)) return;
        showConfirm({
            title: `Unfollow “${context.item.title}”?`,
            text: 'It will leave this chat’s following list and calendar. Release notifications will stop.',
            confirmLabel: 'Unfollow',
            cancelLabel: 'Keep following',
            onConfirm: () => unfollow(context)
        });
    },
    // The search pill and Following's +: Back on the search returns to the tab it came from
    'mine-search-open': () => {
        const from = visibleSection();
        if (from && from !== 'my-search') searchFrom = from;
        const back = $('mine-search-back');
        if (back) back.dataset.section = searchFrom;
        window.setTimeout(() => $('mine-q')?.focus(), 0);
    },
    'mine-search-close': () => {
        window.clearTimeout(searchTimer);
        searchRequest += 1;
        state.query = '';
        state.results = [];
        state.searchError = null;
        state.searching = false;
        const input = /** @type {HTMLInputElement | null} */ ($('mine-q'));
        if (input) input.value = '';
        showResults();
        syncSearchField();
    },
    'mine-search-clear': () => {
        const input = /** @type {HTMLInputElement} */ ($('mine-q'));
        input.value = '';
        searchAccount('');
        syncSearchField();
        input.focus();
    },
    'mine-search-card': (el) => {
        const r = state.results.find((x) => x.tmdbId === el.dataset.id);
        if (r) openNewCard(r);
    },
    'mine-pick-series': (el) => {
        const r = state.results.find((x) => x.tmdbId === el.dataset.id);
        if (r) openNewCard(r);
    },
    'mine-subscribe': (el) => {
        const picked = /** @type {HTMLInputElement | null} */ (
            document.querySelector('input[name="mine-new-mode"]:checked')
        );
        return addTitle(
            el,
            '/series',
            { tmdbId: el.dataset.id, mode: picked ? picked.value : 'episode' },
            () => 'Following'
        );
    },
    'mine-add-film': (el) =>
        addTitle(el, '/films', { tmdbId: el.dataset.id }, ({ released }) =>
            released ? 'The film is already out: added to the released ones' : 'Following: the bot writes when it’s out'
        ),
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

/** The mode radios and the search field. */
export function setupAccount() {
    // The search runs as the person types (after a pause), or at once on Enter (setupSearchForms)
    document.addEventListener('input', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.id !== 'mine-q') return;
        syncSearchField();
        window.clearTimeout(searchTimer);
        const query = input.value.trim();
        searchTimer = window.setTimeout(() => {
            if (query.length >= 2 || !query) searchAccount(query);
        }, 450);
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
                if (state.cal) for (const row of state.cal.items) if (row.tmdbId === s.id) row.mode = el.value;
                // The bells follow the mode: the calendar asks again when it opens
                state.cal = null;
                if (activeFollowing && titleKey(activeFollowing.item, activeFollowing.chatId) === key) {
                    activeFollowing.item.mode = el.value;
                    for (const radio of all('#mine-card-body input[data-mine="mode"]')) {
                        /** @type {HTMLInputElement} */ (radio).checked =
                            /** @type {HTMLInputElement} */ (radio).value === el.value;
                    }
                    const summary = document.querySelector('#mine-card-body .tc-notify-summary strong');
                    if (summary) summary.textContent = NOTIFY[el.value].long;
                }
                toast('Notifications changed', 'success');
                if (state.list && visibleSection() === 'my-subs') $('my-subs-body').innerHTML = subsView();
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
    window.clearTimeout(searchTimer);
    const request = ++searchRequest;
    state.query = query;
    state.searchError = null;
    if (!query) {
        state.results = [];
        state.searching = false;
        showResults();
        return;
    }
    if (!state.chatId) {
        state.searchError = state.chatsError || 'Your chats are still loading. Try again in a moment.';
        showResults();
        return;
    }
    const chatNow = state.chatId;
    state.searching = true;
    showResults();
    try {
        const found = await api(chatPath(`/search?q=${encodeURIComponent(query)}`));
        if (request !== searchRequest || state.chatId !== chatNow) return;
        state.results = found;
    } catch (err) {
        if (request !== searchRequest || state.chatId !== chatNow) return;
        state.searchError = err.message;
    }
    state.searching = false;
    showResults();
}
