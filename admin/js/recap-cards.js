/**
 * Year recap section: what each of the six cards is drawn on (Backgrounds: the pictures, upload
 * and delete, a picker with a preview drawn for a real chat) and the sets drawn so far (Ready
 * cards: ready, out of date or not drawn; view, delete, draw in the background).
 * Server: src/admin/routes/recap-cards.js.
 */

import { $, escapeHtml } from './dom.js';
import { api, apiImage, apiUpload } from './api.js';
import { openModal, closeModal, showConfirm, toast } from './ui.js';
import { showRecap } from './chat-stats.js';

export const CARD_NAMES = ['Cover', 'Episodes', 'Taste', 'Best', 'Farewells', 'Ahead'];
const POLL_MS = 3000;
const THUMB_LOADS = 3;

const years = () => [new Date().getFullYear() - 1, new Date().getFullYear()];
let year = new Date().getFullYear();
let tab = 'looks';
// Only the latest answer may fill the section: a year or tab switched meanwhile outruns the older
const request = { looks: 0, ready: 0, preview: 0 };
/** @type {{ cards: Array<{ card: number, background: string | null, dim: number }>, pictures: any[], maxDim: number, sample: { id: string, name: string } | null } | null} */
let looks = null;
/** @type {{ chats: any[], drawing: { running: boolean, left: number } } | null} */
let ready = null;
let poll = null;

// Object URLs of pictures' small copies, by id: a picture never changes under its id
const pictureUrls = new Map();
// Those of the Ready list's small copies, freed when the list is drawn again
let readyUrls = [];

const kb = (bytes) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
const chats = (n) => `${n} ${n === 1 ? 'chat' : 'chats'}`;
const when = (iso) =>
    new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-action="recap-tab"]'))) {
        const on = btn.dataset.tab === tab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }
    $('recap-looks-pane').hidden = tab !== 'looks';
    $('recap-ready-pane').hidden = tab !== 'ready';
}

/** Entering the section: loads what its tab shows. */
export function openRecapSection() {
    renderYears();
    renderTabs();
    loadLooks();
    if (tab === 'ready') loadReady();
}

function pickYear(value) {
    year = Number(value);
    renderYears();
    loadLooks();
    if (tab === 'ready') loadReady();
}

function pickTab(value) {
    tab = value === 'ready' ? 'ready' : 'looks';
    renderTabs();
    if (tab === 'ready') loadReady();
}

// --- Backgrounds ---

function slotHtml(look) {
    const picture = look.background && looks.pictures.find((p) => p.id === look.background);
    const name = CARD_NAMES[look.card - 1];
    const what = picture ? `${escapeHtml(picture.name)}${look.dim ? ` · dimmed ${look.dim}%` : ''}` : 'Plain colour';
    const art = picture
        ? `<img data-picture="${picture.id}" alt="" /><span class="recap-dim-layer" style="opacity:${look.dim / 100}"></span>`
        : '';
    return `
        <div class="recap-slot">
            <button type="button" class="recap-thumb recap-colour-${look.card}" data-action="recap-look-open" data-card="${look.card}" aria-label="Change what card ${look.card}, ${name}, is drawn on">
                ${art}<span class="recap-thumb-label">${look.card}/6</span>
            </button>
            <div class="recap-slot-name">${look.card} · ${name}</div>
            <div class="recap-slot-what">${what}</div>
            <button type="button" class="btn btn-outline btn-compact recap-slot-change" data-action="recap-look-open" data-card="${look.card}">Change</button>
        </div>`;
}

function pictureHtml(p) {
    const used = p.cards.length ? `card ${p.cards.join(', ')}` : 'unused';
    return `
        <div class="recap-picture">
            <div class="recap-thumb"><img data-picture="${p.id}" alt="${escapeHtml(p.name)}" /></div>
            <button type="button" class="recap-picture-x" data-action="recap-picture-delete" data-id="${p.id}" aria-label="Delete ${escapeHtml(p.name)}">×</button>
            <div class="recap-picture-meta"><b>${escapeHtml(p.name)}</b><span>${used}</span></div>
        </div>`;
}

const UPLOAD_TILE = `
    <button type="button" class="recap-upload" data-action="recap-upload" id="recap-upload-tile">
        <span class="recap-upload-plus" aria-hidden="true">+</span>Upload<span class="recap-upload-or"> or drop here</span>
    </button>`;

function renderLooks() {
    $('recap-slots').innerHTML = looks.cards.map(slotHtml).join('');
    $('recap-pictures').innerHTML = UPLOAD_TILE + looks.pictures.map(pictureHtml).join('');
    $('recap-slots').setAttribute('aria-busy', 'false');
    fillPictures($('recap-looks-pane'));
}

/** Six empty slots and the upload tile, of the loaded size. */
function renderLooksLoading() {
    $('recap-slots').innerHTML = CARD_NAMES.map(
        (name, i) => `
        <div class="recap-slot">
            <div class="recap-thumb"><span class="skeleton"></span></div>
            <div class="recap-slot-name">${i + 1} · ${name}</div>
            <div class="recap-slot-what">&nbsp;</div>
            <button type="button" class="btn btn-outline btn-compact recap-slot-change" disabled>Change</button>
        </div>`
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
        $('recap-slots').innerHTML = `<p class="stats-failed">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
}

/** Sends a chosen or dropped file; the picture list then shows it. */
async function upload(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return toast('A PNG or JPEG picture, please', 'error');
    if (file.size > 5 * 1024 * 1024) return toast('Pictures up to 5 MB', 'error');
    const tile = /** @type {HTMLButtonElement | null} */ ($('recap-upload-tile'));
    if (tile) {
        tile.setAttribute('aria-busy', 'true');
        tile.disabled = true;
    }
    const form = new FormData();
    form.append('picture', file, file.name);
    try {
        const picture = await apiUpload('/recap/backgrounds', form);
        toast(`Added ${picture.name}`, 'success');
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
        ? ` Card ${picture.cards.join(', ')} ${picture.cards.length === 1 ? 'goes' : 'go'} back to ${picture.cards.length === 1 ? 'its' : 'their'} plain colour.`
        : '';
    showConfirm({
        title: `Delete ${picture.name}?`,
        text: `The picture is removed from the server.${using}`,
        confirmLabel: 'Delete',
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
                toast(`Deleted ${picture.name}`, 'success');
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
    $('recap-look-title').textContent = `Card ${card} · ${CARD_NAMES[card - 1]}`;
    $('recap-look-sub').textContent = looks.sample
        ? `Drawn for ${looks.sample.name}, ${year}`
        : 'No chat follows anything yet: no preview to draw';
    $('recap-look-save').textContent = `Use for card ${card}`;
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
        choice(null, 'Plain colour', ''),
        ...looks.pictures.map((p) => choice(p.id, escapeHtml(p.name), `<img data-picture="${p.id}" alt="" />`)),
        `<button type="button" class="recap-choice recap-choice-upload" data-action="recap-upload"><span class="recap-upload"><span class="recap-upload-plus" aria-hidden="true">+</span>Upload</span></button>`
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
                box.innerHTML = `<p class="stats-failed">Nothing to draw yet</p>`;
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
                box.innerHTML = `<img src="${previewUrl}" alt="Card ${picker.card} as it will look" width="1080" height="1350" />`;
            } catch (err) {
                if (asked !== request.preview) return;
                box.innerHTML = `<p class="stats-failed">Failed to draw: ${escapeHtml(err.message)}</p>`;
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
        toast(`Card ${picker.card} saved: every chat's cards are drawn again when next needed`, 'success');
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
    ready: ['ok', 'Ready'],
    old: ['old', 'Out of date'],
    none: ['none', 'Not drawn']
};

function summaryHtml(rows, drawing) {
    const count = (s) => rows.filter((r) => r.state === s).length;
    const bytes = rows.reduce((sum, r) => sum + (r.bytes || 0), 0);
    const todo = count('old') + count('none');
    const fact = (value, label) => `<div class="recap-stat"><b>${value}</b><span>${label}</span></div>`;
    const draw = drawing.running
        ? `<button type="button" class="btn btn-outline" disabled aria-busy="true">Drawing… ${drawing.left} left</button>`
        : `<button type="button" class="btn btn-outline" data-action="recap-draw"${todo ? '' : ' disabled'}>Draw missing and out of date (${todo})</button>`;
    const kept = rows.filter((r) => r.state !== 'none').length;
    return `
        <div class="recap-stats">
            ${fact(count('ready'), 'chats ready')}${fact(count('old'), 'out of date')}${fact(count('none'), 'not drawn')}${fact(kb(bytes), 'on disk')}
        </div>
        <div class="recap-ready-actions">
            ${draw}
            <button type="button" class="btn btn-danger-quiet" data-action="recap-delete-all"${kept ? '' : ' disabled'}>Delete all…</button>
        </div>`;
}

function rowHtml(r) {
    const [kind, label] = STATES[r.state];
    const note =
        r.state === 'ready'
            ? `Drawn ${escapeHtml(when(r.drawnAt))} · ${kb(r.bytes)}`
            : r.state === 'old'
              ? 'Figures or backgrounds changed since'
              : 'Drawn on the first look or send';
    // Not drawn: the six places stay, empty, so every row's columns line up
    const strip = `<div class="recap-strip${r.state === 'none' ? ' recap-strip-empty' : ''}">${[1, 2, 3, 4, 5, 6]
        .map(
            (n) =>
                `<span class="recap-strip-card">${r.state === 'none' ? '' : `<img data-thumb="${r.chatId}:${n}" alt="" />`}</span>`
        )
        .join('')}</div>`;
    const actions =
        r.state === 'none'
            ? `<button type="button" class="btn btn-outline btn-compact" data-action="recap-draw" data-chat="${r.chatId}">Draw</button>`
            : `<button type="button" class="btn btn-outline btn-compact" data-action="recap-view" data-chat="${r.chatId}">View</button>
               <button type="button" class="btn btn-ghost btn-compact" data-action="recap-delete" data-chat="${r.chatId}">Delete</button>`;
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
        : '<li class="empty-note">No chat follows anything yet: there is nothing to draw.</li>';
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
            if (busy) busy.textContent = `Drawing… ${drawing.left} left`;
        } catch {
            // Asked again on the next turn
        }
        followDrawing(asked);
    }, POLL_MS);
}

function renderReadyLoading() {
    $('recap-ready-summary').innerHTML = summaryHtml([], { running: false, left: 0 }).replace(
        /<b>[^<]*<\/b>/g,
        '<b><span class="skeleton recap-stat-skeleton"></span></b>'
    );
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
    if (blank) renderReadyLoading();
    try {
        const answer = await api(`/recap/ready?year=${year}`);
        if (asked !== request.ready) return;
        ready = answer;
        renderReady(answer, asked);
    } catch (err) {
        if (asked !== request.ready) return;
        $('recap-ready-list').innerHTML = `<li class="stats-failed">Failed to load: ${escapeHtml(err.message)}</li>`;
    }
}

async function draw(chatId) {
    try {
        const body = chatId ? { year, chatIds: [chatId] } : { year };
        const answer = await api('/recap/draw', { method: 'POST', body });
        toast(
            answer.drawing.left
                ? `Drawing ${chats(answer.drawing.left)} in the background`
                : 'Nothing to draw: everything is ready',
            'success'
        );
    } catch (err) {
        toast(err.message, 'error');
    }
    loadReady(false);
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
        title: `Delete the cards of ${row.name}?`,
        text: 'Only the files go: the cards are drawn again on the next look or send.',
        confirmLabel: 'Delete',
        onConfirm: async () => {
            try {
                await api(`/recap/ready/${chatId}?year=${year}`, { method: 'DELETE' });
                toast(`Deleted the cards of ${row.name}`, 'success');
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
        title: `Delete the ${year} cards of ${chats(kept)}?`,
        text: 'Only the files go: each chat’s cards are drawn again on its next look or send.',
        confirmLabel: 'Delete all',
        onConfirm: async () => {
            try {
                const answer = await api(`/recap/ready?year=${year}`, { method: 'DELETE' });
                toast(`Deleted the cards of ${chats(answer.removed)}`, 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            loadReady(false);
        }
    });
}

/** The section's buttons, for app.js's delegation. */
export const recapCardActions = {
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
    'recap-delete-all': () => confirmDeleteAll()
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
