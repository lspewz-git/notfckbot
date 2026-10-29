/**
 * Settings → Alerts (src/admin/routes/alerts.js): who gets the bot's alerts, one row each; a row
 * opens what that recipient gets (a preset, or events by group); the shared rules and the last
 * week's log. Everything here is saved at once, not through the Settings bar.
 */

import { $, $field, all, escapeHtml, debounce } from './dom.js';
import { api } from './api.js';
import { toast, openModal, closeModal, showConfirm } from './ui.js';
import { setSelectValue } from './select.js';
import { activeLine, leftLabel, seenInLine, shortDay } from './format.js';

const PRESET_LABELS = { all: 'Everything', critical: 'Critical only' };

/** The last answer of /api/alerts; null until the first. */
let state = null;
// The recipient open in the dialog, and its choice as edited there (saved with Save; closing drops it)
let editing = null;
// The chat picked in Add recipient
let picked = null;
// Set while load() puts the rules into the fields: their change events are not the user's
let filling = false;

const eventsByKey = () => new Map(state.events.map((e) => [e.key, e]));

/** The events a choice turns on. */
function chosen(preset, events) {
    if (preset === 'all') return new Set(state.events.map((e) => e.key));
    if (preset === 'critical') return new Set(state.events.filter((e) => e.critical).map((e) => e.key));
    return new Set(events || []);
}

/** "КЗ" for Константин Загорулько, "#" for a group. */
function initials(r) {
    if (r.type && r.type !== 'private') return '#';
    const words = String(r.name || '?')
        .replace(/^@/, '')
        .split(/\s+/)
        .filter(Boolean);
    return words
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join('');
}

function summary(r) {
    if (r.preset !== 'custom') return { dot: r.preset, text: PRESET_LABELS[r.preset] };
    return { dot: 'custom', text: `${r.events.length} of ${state.events.length}` };
}

function metaLine(r) {
    if (r.unreachable) {
        // missing: the chat is gone from the bot's list; left: lost moments ago, not written yet
        const how = leftLabel({ bot_status: r.unreachable, type: r.type }) || 'The bot lost this chat';
        const when = r.unreachableAt ? ` · ${shortDay(r.unreachableAt)}` : '';
        return { text: `Can't reach: ${how}${when}`, bad: true };
    }
    return { text: r.lastAlertAt ? `Last alert ${seenInLine(r.lastAlertAt)}` : 'No alerts yet', bad: false };
}

function renderPeople() {
    const box = $('alerts-people');
    if (!state.recipients.length) {
        box.innerHTML =
            '<p class="alerts-empty">No one gets alerts yet. Start the bot in Telegram, then add your chat here.</p>';
        $('alerts-test-all').hidden = true;
        return;
    }
    $('alerts-test-all').hidden = false;
    box.innerHTML = state.recipients
        .map((r) => {
            const sum = summary(r);
            const meta = metaLine(r);
            const group = r.type && r.type !== 'private' ? '<span class="alert-tag">group</span>' : '';
            return `<button type="button" class="alert-person" data-action="alert-person" data-id="${escapeHtml(r.chatId)}">
                <span class="alert-ava" aria-hidden="true">${escapeHtml(initials(r))}</span>
                <span class="alert-who">
                    <span class="alert-name"><span class="alert-name-text">${escapeHtml(r.name || r.chatId)}</span>${group}</span>
                    <span class="alert-meta${meta.bad ? ' is-bad' : ''}">${escapeHtml(meta.text)}</span>
                </span>
                <span class="alert-sum"><span class="alert-dot is-${sum.dot}" aria-hidden="true"></span>${escapeHtml(sum.text)}<span class="alert-chev" aria-hidden="true">›</span></span>
            </button>`;
        })
        .join('');
}

/** "14:20" today, "Yest.", else "28 Oct". */
function logTime(iso, now = new Date()) {
    const d = new Date(iso);
    if (d.toDateString() === now.toDateString())
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return d.toDateString() === yesterday.toDateString() ? 'Yest.' : shortDay(iso, now);
}

function renderLog() {
    const list = $('alerts-log');
    if (!state.log.length) {
        list.innerHTML = '<li class="alerts-empty">Nothing this week.</li>';
        return;
    }
    const events = eventsByKey();
    list.innerHTML = state.log
        .map((row) => {
            const event = events.get(row.event);
            const title =
                row.kind === 'test'
                    ? 'Test alert'
                    : row.kind === 'fixed'
                      ? `Fixed: ${event ? event.title : row.event}`
                      : event
                        ? event.title
                        : row.event;
            const tone =
                row.kind === 'fixed' ? 'ok' : row.kind === 'test' ? 'info' : event && event.critical ? 'bad' : 'warn';
            const who = [
                row.sent === 1 && row.sentTo ? row.sentTo : `${row.sent} ${row.sent === 1 ? 'person' : 'people'}`
            ];
            if (row.failed) who.push(`${row.failed} not reached`);
            return `<li><time>${escapeHtml(logTime(row.at))}</time><span class="alert-dot is-${tone}" aria-hidden="true"></span>
                <span>${escapeHtml(title)} <span class="alert-log-who">· ${escapeHtml(who.join(', '))}</span></span></li>`;
        })
        .join('');
}

function renderRules() {
    filling = true;
    try {
        // Only what differs: a refresh mustn't stir a select the user may have open
        const set = (id, value) => $field(id).value !== value && setSelectValue(id, value);
        set('alerts-down-minutes', String(state.rules.downMinutes));
        set('alerts-send-share', state.rules.sendShare);
        set('alerts-repeat-hours', String(state.rules.repeatHours));
    } finally {
        filling = false;
    }
    $('alerts-fixed').setAttribute('aria-checked', String(state.rules.fixed));
    $('alerts-rules').inert = false;
}

function render(next) {
    state = next;
    $('alerts-people').removeAttribute('aria-busy');
    renderPeople();
    renderLog();
    renderRules();
}

/** Loads the card; part of the Settings refresh (data.js). */
export function loadAlerts() {
    return api('/alerts')
        .then(render)
        .catch((err) => {
            // A later refresh that fails keeps what is shown; the first one leaves a dead end, not
            // shimmering rows and default rules that look saved (the rules stay inert)
            if (state) return;
            const failed = `Failed to load: ${escapeHtml(err.message)}`;
            const people = $('alerts-people');
            people.removeAttribute('aria-busy');
            people.innerHTML = `<p class="alerts-empty">${failed}</p>`;
            $('alerts-log').innerHTML = `<li class="alerts-empty">${failed}</li>`;
            $('alerts-test-all').hidden = true;
        });
}

// --- One recipient ---

function renderEditing() {
    const on = chosen(editing.preset, editing.events);
    all('[data-action="alert-preset"]').forEach((b) => {
        const active = b.dataset.preset === editing.preset;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
    });
    $('alert-person-events').innerHTML = state.groups
        .map((g) => {
            const events = state.events.filter((e) => e.group === g.key);
            const count = events.filter((e) => on.has(e.key)).length;
            return `<div class="alert-group">
                <div class="alert-group-head"><span>${escapeHtml(g.title)}</span><span>${count} of ${events.length}</span></div>
                ${events
                    .map(
                        (
                            e
                        ) => `<button type="button" class="alert-event switch" role="switch" aria-checked="${on.has(e.key)}"
                            data-action="alert-event" data-key="${escapeHtml(e.key)}">
                            <span class="alert-dot${e.critical ? ' is-critical' : ''}" aria-hidden="true"></span>
                            <span class="alert-event-label">${escapeHtml(e.label)}</span>
                            <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
                        </button>`
                    )
                    .join('')}
            </div>`;
        })
        .join('');
}

function openPerson(chatId) {
    const r = state && state.recipients.find((x) => x.chatId === chatId);
    if (!r) return;
    editing = { chatId, preset: r.preset, events: r.events || [] };
    $('alert-person-ava').textContent = initials(r);
    $('alert-person-title').textContent = r.name || r.chatId;
    const meta = metaLine(r);
    $('alert-person-sub').textContent = r.unreachable
        ? meta.text
        : `${r.type === 'private' ? 'Private chat' : 'Group'} · ${r.chatId}`;
    renderEditing();
    openModal('alert-person-modal');
}

function pickPreset(preset) {
    // Custom starts from what was on, so the switches don't jump
    editing = { ...editing, events: [...chosen(editing.preset, editing.events)], preset };
    renderEditing();
}

function toggleEvent(key) {
    const on = chosen(editing.preset, editing.events);
    if (on.has(key)) on.delete(key);
    else on.add(key);
    editing = { ...editing, preset: 'custom', events: [...on] };
    renderEditing();
}

async function savePerson() {
    const body = { preset: editing.preset, ...(editing.preset === 'custom' ? { events: editing.events } : {}) };
    try {
        render(await api(`/alerts/recipients/${encodeURIComponent(editing.chatId)}`, { method: 'PUT', body }));
        closeModal('alert-person-modal');
    } catch (err) {
        toast(`Not saved: ${err.message}`, 'error');
    }
}

function removePerson() {
    const { chatId } = editing;
    const r = state.recipients.find((x) => x.chatId === chatId);
    closeModal('alert-person-modal');
    showConfirm({
        title: 'Remove recipient?',
        text: `${r ? r.name || chatId : chatId} will get no more alerts.`,
        confirmLabel: 'Remove',
        cancelLabel: 'Keep',
        onConfirm: async () => {
            try {
                render(await api(`/alerts/recipients/${encodeURIComponent(chatId)}`, { method: 'DELETE' }));
                toast('Removed', 'success');
            } catch (err) {
                toast(`Not removed: ${err.message}`, 'error');
            }
        }
    });
}

async function sendTest(chatId) {
    try {
        const { sent, failed } = await api('/alerts/test', { method: 'POST', body: chatId ? { chatId } : {} });
        if (sent && !failed) toast(sent === 1 ? 'Test sent' : `Test sent to ${sent}`, 'success');
        else if (sent) toast(`Test sent to ${sent}, ${failed} not reached`, 'error');
        else toast("Test didn't go out: the bot can't reach them", 'error');
    } catch (err) {
        toast(`Test failed: ${err.message}`, 'error');
        // Removed meanwhile (another tab): the dialog is about no one now
        if (err.status === 404) closeModal('alert-person-modal');
    }
    loadAlerts();
}

// --- Add recipient ---

let searchSeq = 0;

async function searchCandidates(q) {
    const seq = ++searchSeq;
    const list = $('alert-add-list');
    try {
        const chats = await api(`/alerts/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        // An older search answering late mustn't replace a newer one
        if (seq !== searchSeq) return;
        if (picked && !chats.some((c) => c.chatId === picked)) picked = null;
        $('alert-add-confirm').toggleAttribute('disabled', !picked);
        list.innerHTML = chats.length
            ? chats
                  .map((c) => {
                      const kind = c.type === 'private' ? 'Private' : 'Group';
                      const seen = c.lastSeenAt ? ` · ${activeLine(c.lastSeenAt)}` : '';
                      const selected = c.chatId === picked;
                      return `<button type="button" class="alert-pick${selected ? ' is-picked' : ''}" aria-pressed="${selected}"
                        data-action="alert-pick" data-id="${escapeHtml(c.chatId)}">
                        <span class="alert-ava" aria-hidden="true">${escapeHtml(initials(c))}</span>
                        <span class="alert-who"><span class="alert-name"><span class="alert-name-text">${escapeHtml(c.name || c.chatId)}</span></span>
                        <span class="alert-meta">${escapeHtml(kind + seen)}</span></span>
                        <span class="alert-tick" aria-hidden="true">${selected ? '✓' : ''}</span>
                    </button>`;
                  })
                  .join('')
            : `<p class="alerts-empty">${q ? 'No chat matches.' : 'No chats to add: everyone the bot knows is here already.'}</p>`;
    } catch (err) {
        if (seq === searchSeq)
            list.innerHTML = `<p class="alerts-empty">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
}

function openAdd() {
    picked = null;
    $field('alert-add-search').value = '';
    $('alert-add-list').innerHTML = '';
    $('alert-add-confirm').setAttribute('disabled', '');
    openModal('alert-add-modal');
    searchCandidates('');
}

function pick(chatId) {
    picked = chatId;
    all('.alert-pick').forEach((b) => {
        const on = b.dataset.id === chatId;
        b.classList.toggle('is-picked', on);
        b.setAttribute('aria-pressed', String(on));
        b.querySelector('.alert-tick').textContent = on ? '✓' : '';
    });
    $('alert-add-confirm').removeAttribute('disabled');
}

async function confirmAdd() {
    if (!picked) return;
    try {
        render(await api('/alerts/recipients', { method: 'POST', body: { chatId: picked } }));
        closeModal('alert-add-modal');
        toast('Added: critical alerts only', 'success');
    } catch (err) {
        toast(`Not added: ${err.message}`, 'error');
    }
}

// --- Rules ---

async function saveRules(change) {
    if (!state) return;
    const body = { ...state.rules, ...change };
    try {
        render(await api('/alerts/rules', { method: 'PUT', body }));
        toast('Saved', 'success');
    } catch (err) {
        toast(`Not saved: ${err.message}`, 'error');
        renderRules();
    }
}

const RULE_PARSE = { downMinutes: Number, sendShare: String, repeatHours: Number };

export const alertsActions = {
    'alerts-add': () => openAdd(),
    'alerts-test-all': () => sendTest(null),
    'alerts-fixed': () => state && saveRules({ fixed: !state.rules.fixed }),
    'alert-person': (el) => openPerson(el.dataset.id),
    'alert-preset': (el) => pickPreset(el.dataset.preset),
    'alert-event': (el) => toggleEvent(el.dataset.key),
    'alert-save': () => savePerson(),
    'alert-remove': () => removePerson(),
    'alert-test-one': () => editing && sendTest(editing.chatId),
    'alert-pick': (el) => pick(el.dataset.id),
    'alert-add-confirm': () => confirmAdd()
};

export function setupAlerts() {
    all('[data-alert-rule]').forEach((select) => {
        select.addEventListener('change', (e) => {
            // Not the Settings bar's: this card saves on its own
            e.stopPropagation();
            if (filling) return;
            const name = select.dataset.alertRule;
            saveRules({ [name]: RULE_PARSE[name](/** @type {HTMLSelectElement} */ (select).value) });
        });
    });
    $field('alert-add-search').addEventListener(
        'input',
        debounce((e) => searchCandidates(e.target.value.trim()), 300)
    );
}
