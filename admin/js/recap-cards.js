import { locale } from './i18n.js';
import { t as i18nText } from './i18n.js';
/**
 * Year recap section: what each of the six cards is drawn on (Backgrounds: the pictures, upload
 * and delete, a picker with a preview drawn for a real chat) and the sets drawn so far (Ready
 * cards: ready, out of date or not drawn; view, delete, draw in the background); the third tab,
 * Schedule, is recap-schedule.js. Server: src/admin/routes/recap-cards.js.
 */

import { $, escapeHtml } from './dom.js';
import { api, apiImage, apiUpload } from './api.js';
import { openModal, closeModal, showConfirm, toast } from './ui.js';
import { showRecap } from './chat-stats.js';
import { pickFrom } from './pick-sheet.js';
import { loadSchedule, scheduleYear } from './recap-schedule.js';

export const CARD_NAMES = [
    i18nText('Cover'),
    i18nText('Episodes'),
    i18nText('Taste'),
    i18nText('Best'),
    i18nText('Farewells'),
    i18nText('Ahead')
];
const POLL_MS = 3000;
const THUMB_LOADS = 3;

const years = () => [new Date().getFullYear() - 1, new Date().getFullYear()];
let year = new Date().getFullYear();
let tab = 'ready';
export const recapSendYear = () => (tab === 'schedule' ? scheduleYear() : year);
// Only the latest answer may fill the section: a year or tab switched meanwhile outruns the older
const request = { looks: 0, ready: 0, preview: 0 };
/** @type {{ cards: Array<{ card: number, background: string | null, dim: number }>, pictures: any[], maxDim: number, sample: { id: string, name: string } | null } | null} */
let looks = null;
/** @type {{ chats: any[], drawing: { running: boolean, left: number } } | null} */
let ready = null;
let poll = null;
let generating = false;

// Object URLs of pictures' small copies, by id: a picture never changes under its id
const pictureUrls = new Map();
// Those of the Ready list's small copies, freed when the list is drawn again
let readyUrls = [];

const kb = (bytes) =>
    bytes >= 1024 * 1024
        ? i18nText('{{v0}} MB', { v0: (bytes / 1024 / 1024).toFixed(1) })
        : i18nText('{{v0}} KB', { v0: Math.round(bytes / 1024) });
const chats = (count) => i18nText('{{count}} chat', { count });
const when = (iso) =>
    new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A picture's small copy as an object URL (fetched once). */
async function pictureUrl(id) {
    if (!pictureUrls.has(id)) {
        pictureUrls.set(
            id,
            apiImage(`/recap/backgrounds/${id}?size=thumb`).then((blob) => URL.createObjectURL(blob))
        );
    }
    try {
        return await pictureUrls.get(id);
    } catch (err) {
        pictureUrls.delete(id);
        throw err;
    }
}

/** Fills every <img data-picture="id"> under root with its picture. */
function fillPictures(root) {
    for (const img of /** @type {NodeListOf<HTMLImageElement>} */ (root.querySelectorAll('img[data-picture]'))) {
        pictureUrl(img.dataset.picture).then(
            (url) => {
                img.src = url;
            },
            () => img.remove()
        );
    }
}

// --- The section ---

function renderYears() {
    $('recap-years').innerHTML = years()
        .map(
            (y) =>
                `<button type="button" class="btn btn-ghost${y === year ? ' active' : ''}" data-action="recap-year" data-year="${y}" aria-pressed="${y === year}">${y}</button>`
        )
        .join('');
}

function renderTabs() {
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (
        document.querySelectorAll('#recap-section [data-action="recap-tab"]')
    )) {
        const on = btn.dataset.tab === tab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }
    $('recap-looks-pane').hidden = tab !== 'looks';
    $('recap-ready-pane').hidden = tab !== 'ready';
    $('recap-sched-pane').hidden = tab !== 'schedule';
    // The schedule has its own year, the day's
    $('recap-years').hidden = tab === 'schedule';
    const send = document.querySelector('#recap-section [data-action="recap-send-open"]');
    if (send) /** @type {HTMLButtonElement} */ (send).disabled = tab === 'schedule' && scheduleYear() === null;
}

/** Entering the section: loads what its tab shows. */
export function openRecapSection() {
    renderYears();
    renderTabs();
    if (tab === 'looks') loadLooks();
    if (tab === 'ready') loadReady();
    if (tab === 'schedule') loadSchedule();
}

function pickYear(value) {
    year = Number(value);
    renderYears();
    if (tab === 'looks') loadLooks();
    if (tab === 'ready') loadReady();
}

function pickTab(value) {
    tab = ['ready', 'schedule'].includes(value) ? value : 'looks';
    renderTabs();
    // Not in the section yet (the link in Settings): entering it loads the tab
    if (!$('recap-section').classList.contains('active')) return;
    if (tab === 'looks') loadLooks();
    if (tab === 'ready') loadReady();
    if (tab === 'schedule') loadSchedule();
}

// --- Backgrounds ---

function slotHtml(look) {
    const picture = look.background && looks.pictures.find((p) => p.id === look.background);
    const name = CARD_NAMES[look.card - 1];
    const what = picture
        ? `${escapeHtml(picture.name)}${look.dim ? ' ' + i18nText('· dimmed {{v0}}%', { v0: look.dim }) : ''}`
        : i18nText('Plain colour');
    const art = picture
        ? `<img data-picture="${picture.id}" alt="" /><span class="recap-dim-layer" style="opacity:${look.dim / 100}"></span>`
        : '';
    return (
        '\n        <div class="recap-slot">\n            <button type="button" class="recap-thumb recap-colour-' +
        look.card +
        '" data-action="recap-look-open" data-card="' +
        look.card +
        '" aria-label="' +
        i18nText('Change what card {{v2}}, {{v3}}, is drawn on', { v2: look.card, v3: name }) +
        '">\n                ' +
        art +
        '<span class="recap-thumb-label">' +
        look.card +
        '/6</span>\n            </button>\n            <div class="recap-slot-name">' +
        look.card +
        ' · ' +
        name +
        '</div>\n            <div class="recap-slot-what">' +
        what +
        '</div>\n            <button type="button" class="btn btn-outline btn-compact recap-slot-change" data-action="recap-look-open" data-card="' +
        look.card +
        '">' +
        i18nText('Change background') +
        '</button>\n        </div>'
    );
}

function pictureHtml(p) {
    const used = p.cards.length ? i18nText('card {{v0}}', { v0: p.cards.join(', ') }) : 'unused';
    return (
        '\n        <div class="recap-picture">\n            <div class="recap-thumb"><img data-picture="' +
        p.id +
        '" alt="' +
        escapeHtml(p.name) +
        '" /></div>\n            <button type="button" class="recap-picture-x" data-action="recap-picture-delete" data-id="' +
        p.id +
        '" aria-label="' +
        i18nText('Delete {{v3}}', { v3: escapeHtml(p.name) }) +
        '">×</button>\n            <div class="recap-picture-meta"><b>' +
        escapeHtml(p.name) +
        '</b><span>' +
        used +
        '</span></div>\n        </div>'
    );
}

const UPLOAD_TILE =
    '\n    <button type="button" class="recap-upload" data-action="recap-upload" id="recap-upload-tile">\n        <span class="recap-upload-plus" aria-hidden="true">+</span>' +
    i18nText('Upload') +
    '<span class="recap-upload-or">' +
    ' ' +
    i18nText('or drop here') +
    '</span>\n    </button>';

function renderLooks() {
    $('recap-slots').innerHTML = looks.cards.map(slotHtml).join('');
    $('recap-pictures').innerHTML = UPLOAD_TILE + looks.pictures.map(pictureHtml).join('');
    $('recap-slots').setAttribute('aria-busy', 'false');
    fillPictures($('recap-looks-pane'));
}

/** Six empty slots and the upload tile, of the loaded size. */
function renderLooksLoading() {
    $('recap-slots').innerHTML = CARD_NAMES.map(
        (name, i) =>
            '\n        <div class="recap-slot">\n            <div class="recap-thumb"><span class="skeleton"></span></div>\n            <div class="recap-slot-name">' +
            (i + 1) +
            ' · ' +
            name +
            '</div>\n            <div class="recap-slot-what">&nbsp;</div>\n            <button type="button" class="btn btn-outline btn-compact recap-slot-change" disabled>' +
            i18nText('Change background') +
            '</button>\n        </div>'
    ).join('');
    $('recap-slots').setAttribute('aria-busy', 'true');
    $('recap-pictures').innerHTML = UPLOAD_TILE;
}

async function loadLooks() {
    const asked = ++request.looks;
    if (!looks) renderLooksLoading();
    try {
        const answer = await api(`/recap/looks?year=${year}`);
        if (asked !== request.looks) return;
        looks = answer;
        renderLooks();
    } catch (err) {
        if (asked !== request.looks) return;
        $('recap-slots').innerHTML =
            '<p class="stats-failed">' + i18nText('Failed to load: {{v0}}', { v0: escapeHtml(err.message) }) + '</p>';
    }
}

/** Sends a chosen or dropped file; the picture list then shows it. */
async function upload(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type))
        return toast(i18nText('A PNG or JPEG picture, please'), 'error');
    if (file.size > 5 * 1024 * 1024) return toast(i18nText('Pictures up to 5 MB'), 'error');
    const tile = /** @type {HTMLButtonElement | null} */ ($('recap-upload-tile'));
    if (tile) {
        tile.setAttribute('aria-busy', 'true');
        tile.disabled = true;
    }
    const form = new FormData();
    form.append('picture', file, file.name);
    try {
        const picture = await apiUpload('/recap/backgrounds', form);
        toast(i18nText('Added {{v0}}', { v0: picture.name }), 'success');
        await loadLooks();
        if (picker.card) renderPicker();
    } catch (err) {
        toast(err.message, 'error');
        if (tile) {
            tile.removeAttribute('aria-busy');
            tile.disabled = false;
        }
    }
}

function confirmDeletePicture(id) {
    const picture = looks && looks.pictures.find((p) => p.id === id);
    if (!picture) return;
    const using = picture.cards.length
        ? ' ' +
          i18nText(
              picture.cards.length === 1
                  ? 'Card {{v0}} goes back to its plain colour.'
                  : 'Cards {{v0}} go back to their plain colour.',
              { v0: picture.cards.join(', ') }
          )
        : '';
    showConfirm({
        title: i18nText('Delete {{v0}}?', { v0: picture.name }),
        text: i18nText('The picture is removed from the server.{{v0}}', { v0: using }),
        confirmLabel: i18nText('Delete'),
        onConfirm: async () => {
            try {
                await api(`/recap/backgrounds/${id}`, { method: 'DELETE' });
                const url = pictureUrls.get(id);
                pictureUrls.delete(id);
                if (url)
                    url.then(
                        (u) => URL.revokeObjectURL(u),
                        () => {}
                    );
                toast(i18nText('Deleted {{v0}}', { v0: picture.name }), 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            loadLooks();
        }
    });
}

// --- The picker: a card's picture and dim, with the card drawn for a real chat ---

const picker = { card: 0, background: null, dim: 0 };
let previewUrl = null;
let previewTimer = null;

function openPicker(card) {
    if (!looks) return;
    const look = looks.cards[card - 1];
    Object.assign(picker, { card, background: look.background, dim: look.dim });
    $('recap-look-title').textContent = i18nText('Card {{v0}} · {{v1}}', { v0: card, v1: CARD_NAMES[card - 1] });
    $('recap-look-sub').textContent = looks.sample
        ? i18nText('Drawn for {{v0}}, {{v1}}', { v0: looks.sample.name, v1: year })
        : i18nText('No chat follows anything yet: no preview to draw');
    $('recap-look-save').textContent = i18nText('Use for card {{v0}}', { v0: card });
    // Not the last card's picture while this one is drawn
    $('recap-look-preview').innerHTML = '<span class="skeleton"></span>';
    renderPicker();
    openModal('recap-look-modal');
    loadPreview(true);
}

function renderPicker() {
    const choice = (id, label, art, extra = '') =>
        `<button type="button" class="recap-choice${picker.background === id ? ' active' : ''}" data-action="recap-look-pick" data-id="${id || ''}" aria-pressed="${picker.background === id}"${extra}>
            <span class="recap-thumb${id ? '' : ` recap-colour-${picker.card}`}">${art}</span><small>${label}</small></button>`;
    $('recap-look-choices').innerHTML = [
        choice(null, i18nText('Plain colour'), ''),
        ...looks.pictures.map((p) => choice(p.id, escapeHtml(p.name), `<img data-picture="${p.id}" alt="" />`)),
        '<button type="button" class="recap-choice recap-choice-upload" data-action="recap-upload"><span class="recap-upload"><span class="recap-upload-plus" aria-hidden="true">+</span>' +
            i18nText('Upload') +
            '</span></button>'
    ].join('');
    fillPictures($('recap-look-choices'));
    const range = /** @type {HTMLInputElement} */ ($('recap-dim'));
    range.max = String(looks.maxDim);
    range.value = String(picker.dim);
    range.disabled = !picker.background;
    $('recap-dim-value').textContent = `${picker.dim}%`;
}

/** Draws the card on the picked look; a moment after the last change, so dragging asks once. */
function loadPreview(now = false) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(
        async () => {
            const box = $('recap-look-preview');
            if (!looks.sample) {
                box.innerHTML = '<p class="stats-failed">' + i18nText('Nothing to draw yet') + '</p>';
                return;
            }
            const asked = ++request.preview;
            box.setAttribute('aria-busy', 'true');
            if (!box.querySelector('img')) box.innerHTML = '<span class="skeleton"></span>';
            const params = new URLSearchParams({ chat: looks.sample.id, year: String(year) });
            if (picker.background) params.set('background', picker.background);
            params.set('dim', String(picker.background ? picker.dim : 0));
            try {
                const blob = await apiImage(`/recap/preview/${picker.card}?${params}`);
                if (asked !== request.preview) return;
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                previewUrl = URL.createObjectURL(blob);
                box.innerHTML =
                    '<img src="' +
                    previewUrl +
                    '" alt="' +
                    i18nText('Card {{v1}} as it will look', { v1: picker.card }) +
                    '" width="1080" height="1350" />';
            } catch (err) {
                if (asked !== request.preview) return;
                box.innerHTML =
                    '<p class="stats-failed">' +
                    i18nText('Failed to draw: {{v0}}', { v0: escapeHtml(err.message) }) +
                    '</p>';
            }
            box.removeAttribute('aria-busy');
        },
        now ? 0 : 400
    );
}

function pickLook(id) {
    picker.background = id || null;
    if (!picker.background) picker.dim = 0;
    renderPicker();
    loadPreview();
}

function setDim(value) {
    picker.dim = Number(value);
    $('recap-dim-value').textContent = `${picker.dim}%`;
    loadPreview();
}

async function saveLook() {
    const btn = /** @type {HTMLButtonElement} */ ($('recap-look-save'));
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
        const answer = await api(`/recap/looks/${picker.card}`, {
            method: 'PUT',
            body: { background: picker.background, dim: picker.dim }
        });
        looks.cards = answer.cards;
        closeModal('recap-look-modal');
        toast(
            i18nText("Card {{v0}} saved: every chat's cards are drawn again when next needed", { v0: picker.card }),
            'success'
        );
        loadLooks();
        if (ready) loadReady(false);
    } catch (err) {
        toast(err.message, 'error');
    }
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
}

// --- Ready cards ---

const STATES = {
    ready: ['ok', i18nText('Ready')],
    old: ['old', i18nText('Out of date')],
    none: ['none', i18nText('Not generated')]
};

function summaryHtml(rows, drawing, loading = false) {
    const count = (state) => rows.filter((r) => r.state === state).length;
    const todo = count('old') + count('none');
    const bytes = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
    const kept = rows.filter((row) => row.state !== 'none').length;
    const placeholder = '<span class="skeleton recap-stat-skeleton"></span>';
    const action = drawing.running
        ? '<button type="button" class="btn btn-primary" disabled aria-busy="true">' +
          i18nText('Generating… {{v0}} left', { v0: drawing.left }) +
          '</button>'
        : '<button type="button" class="btn btn-primary" data-action="recap-draw"' +
          (loading || !todo ? ' disabled' : '') +
          ('>' + i18nText('Generate cards') + '') +
          (todo ? ' (' + todo + ')' : '') +
          '</button>';
    return (
        '<div class="recap-readiness" aria-busy="' +
        loading +
        '">\n        <div class="recap-readiness-main">\n            <div><div class="recap-readiness-count"><b>' +
        (loading ? placeholder : count('ready')) +
        '</b><span> / ' +
        (loading ? '—' : rows.length) +
        '</span></div><div class="recap-readiness-label">' +
        i18nText('chats ready') +
        '</div></div>\n            <div class="recap-readiness-status"><span>' +
        (loading ? placeholder : count('old') + (' ' + i18nText('out of date'))) +
        '</span><span>' +
        (loading ? placeholder : count('none') + (' ' + i18nText('not generated'))) +
        '</span></div>\n            ' +
        action +
        '\n        </div>\n        <div class="recap-readiness-footer"><span>' +
        (loading ? placeholder : i18nText('{{v0}} stored', { v0: kb(bytes) })) +
        '</span><button type="button" class="btn btn-ghost btn-compact" data-action="recap-ready-menu"' +
        (loading || !kept ? ' disabled' : '') +
        '>' +
        i18nText('More…') +
        '</button></div>\n    </div>'
    );
}

function rowHtml(r) {
    const [kind, label] = STATES[r.state];
    const note =
        r.state === 'ready'
            ? i18nText('Generated {{v0}} · {{v1}}', { v0: escapeHtml(when(r.drawnAt)), v1: kb(r.bytes) })
            : r.state === 'old'
              ? i18nText('Statistics or backgrounds changed')
              : i18nText('Generated when previewed or sent');
    // Not drawn: the six places stay, empty, so every row's columns line up
    const strip = `<div class="recap-strip${r.state === 'none' ? ' recap-strip-empty' : ''}">${[1, 2, 3, 4, 5, 6]
        .map(
            (n) =>
                `<span class="recap-strip-card">${r.state === 'none' ? '' : `<img data-thumb="${r.chatId}:${n}" alt="" />`}</span>`
        )
        .join('')}</div>`;
    const main =
        r.state === 'ready'
            ? '<button type="button" class="btn btn-outline btn-compact" data-action="recap-view" data-chat="' +
              escapeHtml(r.chatId) +
              ('">' + i18nText('Preview') + '</button>')
            : '<button type="button" class="btn btn-outline btn-compact" data-action="recap-draw" data-chat="' +
              escapeHtml(r.chatId) +
              '">' +
              (r.state === 'old' ? i18nText('Regenerate') : i18nText('Generate')) +
              '</button>';
    const more =
        r.state === 'none'
            ? ''
            : '<button type="button" class="btn btn-ghost btn-compact" data-action="recap-row-menu" data-chat="' +
              escapeHtml(r.chatId) +
              ('" aria-label="' + i18nText('More actions for') + ' ') +
              escapeHtml(r.name) +
              '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-ellipsis" /></svg></button>';
    const actions = main + more;
    return `
        <li class="recap-row">
            <div class="recap-row-who"><b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.chatId)} · ${escapeHtml(r.type || 'private')}</span></div>
            ${strip}
            <div class="recap-row-state"><span class="recap-tag recap-tag-${kind}">${label}</span><span>${note}</span></div>
            <div class="recap-row-actions">${actions}</div>
        </li>`;
}

/** The small copies of the list's cards, a few requests at a time. */
async function fillThumbs(asked, shownYear) {
    const imgs = [
        .../** @type {NodeListOf<HTMLImageElement>} */ ($('recap-ready-list').querySelectorAll('img[data-thumb]'))
    ];
    const next = async () => {
        while (imgs.length) {
            const img = imgs.shift();
            const [chat, n] = img.dataset.thumb.split(':');
            try {
                const blob = await apiImage(`/recap/ready/${chat}/thumb/${n}?year=${shownYear}`);
                if (asked !== request.ready) return;
                const url = URL.createObjectURL(blob);
                readyUrls.push(url);
                img.src = url;
            } catch {
                img.remove();
            }
        }
    };
    await Promise.all(Array.from({ length: THUMB_LOADS }, next));
}

function renderReady(answer, asked) {
    for (const url of readyUrls) URL.revokeObjectURL(url);
    readyUrls = [];
    $('recap-ready-summary').innerHTML = summaryHtml(answer.chats, answer.drawing);
    $('recap-ready-list').innerHTML = answer.chats.length
        ? answer.chats.map(rowHtml).join('')
        : '<li class="empty-note">' +
          i18nText('No chat follows anything yet: there are no cards to generate.') +
          '</li>';
    $('recap-ready-list').setAttribute('aria-busy', 'false');
    fillThumbs(asked, year);
    clearTimeout(poll);
    if (answer.drawing.running) followDrawing(asked);
}

/**
 * While the background drawing goes: asks only how far it is (counting every chat's state again is
 * work for the server), and loads the list once it is over. Stops when the section is left.
 */
function followDrawing(asked) {
    poll = setTimeout(async () => {
        if (asked !== request.ready || tab !== 'ready' || !$('recap-section').classList.contains('active')) return;
        try {
            const drawing = await api('/recap/drawing');
            if (asked !== request.ready) return;
            if (!drawing.running) return loadReady(false);
            const busy = $('recap-ready-summary').querySelector('.btn[aria-busy="true"]');
            if (busy) busy.textContent = i18nText('Generating… {{v0}} left', { v0: drawing.left });
        } catch {
            // Asked again on the next turn
        }
        followDrawing(asked);
    }, POLL_MS);
}

function renderReadyLoading() {
    $('recap-ready-summary').innerHTML = summaryHtml([], { running: false, left: 0 }, true);
    $('recap-ready-list').innerHTML = [1, 2, 3]
        .map(
            () =>
                `<li class="recap-row"><div class="recap-row-who"><span class="skeleton"></span></div><div class="recap-strip">${'<span class="recap-strip-card"></span>'.repeat(6)}</div><div class="recap-row-state"><span class="skeleton"></span></div><div class="recap-row-actions"></div></li>`
        )
        .join('');
    $('recap-ready-list').setAttribute('aria-busy', 'true');
}

async function loadReady(blank = true) {
    const asked = ++request.ready;
    clearTimeout(poll);
    if (blank) {
        ready = null;
        renderReadyLoading();
    }
    try {
        const answer = await api(`/recap/ready?year=${year}`);
        if (asked !== request.ready) return;
        ready = answer;
        renderReady(answer, asked);
    } catch (err) {
        if (asked !== request.ready) return;
        ready = null;
        $('recap-ready-summary').innerHTML =
            '<button type="button" class="btn btn-outline" data-action="recap-ready-retry">' +
            i18nText('Try again') +
            '</button>';
        $('recap-ready-list').innerHTML =
            '<li class="stats-failed">' + i18nText('Failed to load: {{v0}}', { v0: escapeHtml(err.message) }) + '</li>';
        $('recap-ready-list').setAttribute('aria-busy', 'false');
    }
}

async function draw(chatId) {
    if (!ready || generating || ready.drawing.running) return;
    generating = true;
    try {
        const body = chatId ? { year, chatIds: [chatId] } : { year };
        const answer = await api('/recap/draw', { method: 'POST', body });
        toast(
            answer.drawing.left
                ? i18nText('Generating {{v0}} in the background', { v0: chats(answer.drawing.left) })
                : i18nText('All cards are ready'),
            'success'
        );
    } catch (err) {
        toast(err.message, 'error');
    }
    await loadReady(false);
    generating = false;
}

function view(chatId) {
    const row = ready && ready.chats.find((r) => r.chatId === chatId);
    if (!row) return;
    // Closing the preview leaves the section as it was; the list then shows what changed
    showRecap(chatId, row.name, year, () => loadReady(false));
}

function confirmDelete(chatId) {
    const row = ready && ready.chats.find((r) => r.chatId === chatId);
    if (!row) return;
    showConfirm({
        title: i18nText('Delete the cards of {{v0}}?', { v0: row.name }),
        text: i18nText('Only the files go: the cards are drawn again on the next look or send.'),
        confirmLabel: i18nText('Delete'),
        onConfirm: async () => {
            try {
                await api(`/recap/ready/${chatId}?year=${year}`, { method: 'DELETE' });
                toast(i18nText('Deleted the cards of {{v0}}', { v0: row.name }), 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            loadReady(false);
        }
    });
}

function confirmDeleteAll() {
    const kept = ready ? ready.chats.filter((r) => r.state !== 'none').length : 0;
    if (!kept) return;
    showConfirm({
        title: i18nText('Delete the {{v0}} cards of {{v1}}?', { v0: year, v1: chats(kept) }),
        text: i18nText('Only the files go: each chat’s cards are drawn again on its next look or send.'),
        confirmLabel: i18nText('Delete all'),
        onConfirm: async () => {
            try {
                const answer = await api(`/recap/ready?year=${year}`, { method: 'DELETE' });
                toast(i18nText('Deleted the cards of {{v0}}', { v0: chats(answer.removed) }), 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            loadReady(false);
        }
    });
}

/** The section's buttons, for app.js's delegation. */
export const recapCardActions = {
    'recap-ready-retry': () => loadReady(),
    'recap-year': (el) => pickYear(el.dataset.year),
    'recap-tab': (el) => pickTab(el.dataset.tab),
    'recap-look-open': (el) => openPicker(Number(el.dataset.card)),
    'recap-look-pick': (el) => pickLook(el.dataset.id),
    'recap-look-save': () => saveLook(),
    'recap-upload': () => /** @type {HTMLInputElement} */ ($('recap-upload')).click(),
    'recap-picture-delete': (el) => confirmDeletePicture(el.dataset.id),
    'recap-draw': (el) => draw(el.dataset.chat),
    'recap-view': (el) => view(el.dataset.chat),
    'recap-delete': (el) => confirmDelete(el.dataset.chat),
    'recap-delete-all': () => confirmDeleteAll(),
    'recap-ready-menu': () =>
        pickFrom({
            title: i18nText('Stored cards'),
            value: '',
            options: [
                {
                    value: 'clear',
                    label: i18nText('Clear generated files…'),
                    hint: i18nText('Cards can be regenerated. Sending history is kept.')
                }
            ],
            onPick: () => confirmDeleteAll()
        }),
    'recap-row-menu': (el) =>
        pickFrom({
            title: i18nText('Card actions'),
            value: '',
            options: [
                { value: 'preview', label: i18nText('Preview cards') },
                {
                    value: 'clear',
                    label: i18nText('Clear generated files…'),
                    hint: i18nText('Sending history is kept.')
                }
            ],
            onPick: (action) => (action === 'preview' ? view(el.dataset.chat) : confirmDelete(el.dataset.chat))
        })
};

/** The file field, dropping a picture on the upload tile, and the dim slider. */
export function setupRecapCards() {
    const input = /** @type {HTMLInputElement} */ ($('recap-upload'));
    input.addEventListener('change', () => {
        upload(input.files && input.files[0]);
        input.value = '';
    });
    const pane = $('recap-looks-pane');
    pane.addEventListener('dragover', (e) => {
        if (!(/** @type {HTMLElement} */ (e.target).closest('.recap-upload'))) return;
        e.preventDefault();
        /** @type {HTMLElement} */ (e.target).closest('.recap-upload').classList.add('dragging');
    });
    pane.addEventListener('dragleave', (e) => {
        const tile = /** @type {HTMLElement} */ (e.target).closest('.recap-upload');
        if (tile) tile.classList.remove('dragging');
    });
    pane.addEventListener('drop', (e) => {
        const tile = /** @type {HTMLElement} */ (e.target).closest('.recap-upload');
        if (!tile) return;
        e.preventDefault();
        tile.classList.remove('dragging');
        upload(e.dataTransfer && e.dataTransfer.files[0]);
    });
    $('recap-dim').addEventListener('input', (e) => setDim(/** @type {HTMLInputElement} */ (e.target).value));
}
