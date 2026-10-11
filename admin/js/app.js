/** Entry point: navigation, the refresh timer, and all event wiring. */

import { $, $field, all, closest, setText, debounce, target } from './dom.js';
import { fetchData, setSection } from './data.js';
import { setupFilters, setTableTab } from './tables.js';
import { filterLogs } from './logs.js';
import { openModal, closeModal, closeModalReturning, topmostModal } from './ui.js';
import { enhanceSelects, closeDropdown, isDropdownOpen } from './select.js';
import { setupProxyForm, openProxyModal } from './proxy.js';
import { openServiceModal, setupServiceDialog } from './services.js';
import { openChatActions, searchContent, selectContent, submitAddContent } from './chats.js';
import { openSeriesDetails, openModeModal, deleteSub, deleteWatchlistItem } from './records.js';
import { triggerCheck, openBroadcastModal, sendBroadcast, confirmWipeAll } from './maintenance.js';

const REFRESH_SECONDS = 10;

// --- Navigation ---

function switchSection(id) {
    setSection(id);
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `${id}-section`));
    // Sidebar items and tab-bar items; "More" counts as active for the sections it holds
    all('.nav-item, .tab-item').forEach((n) => {
        const on = n.dataset.section === id || (n.dataset.tabSections || '').split(' ').includes(id);
        n.classList.toggle('active', on);
        // Screen readers announce the current section, not just a coloured row
        if (on) n.setAttribute('aria-current', 'page');
        else n.removeAttribute('aria-current');
    });
    fetchData();
}

// --- Refresh timer ---
let secondsLeft = REFRESH_SECONDS;
let isPaused = true;

function updatePauseButton() {
    const btn = $('pause-refresh');
    if (!btn) return;
    btn.innerText = isPaused ? 'Resume' : 'Pause';
    // Both are single-class selectors, so leaving .btn-ghost on would win on
    // source order and the paused state would show no highlight at all.
    btn.classList.toggle('btn-primary', isPaused);
    btn.classList.toggle('btn-ghost', !isPaused);
    // Countdown is meaningless while paused
    setText('refresh-timer', isPaused ? '—' : secondsLeft);
}

function startTimer() {
    setInterval(() => {
        if (isPaused) return;
        secondsLeft--;
        if (secondsLeft <= 0) {
            secondsLeft = REFRESH_SECONDS;
            fetchData();
        }
        setText('refresh-timer', secondsLeft);
    }, 1000);
}

// --- Event delegation ---
// Generated markup carries data-* attributes only, so nothing has to be
// reachable from the global scope and no value ends up inside executable code.
const CLICK_ACTIONS = {
    'chat-actions': (el) => openChatActions(el.dataset.id),
    series: (el) => openSeriesDetails(el.dataset.id),
    mode: (el) => openModeModal(el.dataset.key),
    'delete-sub': (el) => deleteSub(el.dataset.chat, el.dataset.series),
    'delete-film': (el) => deleteWatchlistItem(el.dataset.id),
    'select-content': (el) => selectContent(Number(el.dataset.index)),
    proxy: () => openProxyModal(),
    service: (el) => openServiceModal(el.dataset.service, el.dataset.label)
};

const DELEGATED =
    '[data-action], [data-section], [data-close], [data-close-return], [data-open], [data-log-filter], [data-subs-tab]';

function setupDelegation() {
    document.addEventListener('click', (e) => {
        const el = closest(e, DELEGATED);
        if (!el) return;

        const { action, section, close, closeReturn, open, logFilter, subsTab } = el.dataset;

        if (action && CLICK_ACTIONS[action]) CLICK_ACTIONS[action](el);
        // Before the section switch, so the dashboard card lands on the right tab
        if (subsTab) setTableTab('subs', subsTab);
        if (section) switchSection(section);
        if (close) closeModal(close);
        if (closeReturn) closeModalReturning(closeReturn);
        // After any close, so a menu row can swap its sheet for the dialog it names
        if (open) openModal(open);
        if (logFilter) filterLogs(logFilter);
    });

    // A click on the dimmed backdrop dismisses the dialog, like Cancel. The press must also
    // start there: dragging a text selection out of a field ends the click on the backdrop too.
    let pressedBackdrop = null;
    document.addEventListener('mousedown', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        pressedBackdrop = t.classList && t.classList.contains('modal') ? t : null;
    });
    document.addEventListener('click', (e) => {
        if (pressedBackdrop && e.target === pressedBackdrop) closeModalReturning(pressedBackdrop.id);
        pressedBackdrop = null;
    });

    // Delegated targets are often <li> or <td>, which the browser will not
    // activate from the keyboard on its own
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = closest(e, DELEGATED);
        if (!el || !el.hasAttribute('tabindex')) return;
        e.preventDefault();
        el.click();
    });
}

function setupControls() {
    $('pause-refresh').onclick = () => {
        isPaused = !isPaused;
        if (!isPaused) secondsLeft = REFRESH_SECONDS;
        updatePauseButton();
    };

    $('refresh-btn').onclick = async (e) => {
        const btn = target(e);
        btn.classList.add('spinning');
        secondsLeft = REFRESH_SECONDS;
        try {
            await fetchData();
        } finally {
            btn.classList.remove('spinning');
        }
    };

    $('actions-btn').onclick = () => openModal('actions-modal');
    $('danger-btn').onclick = () => openModal('danger-modal');
    $('trigger-btn').onclick = triggerCheck;
    $('broadcast-btn').onclick = openBroadcastModal;
    $('send-broadcast').onclick = sendBroadcast;
    $('wipe-all-btn').onclick = confirmWipeAll;
    $('confirm-add-content').onclick = submitAddContent;
    setupServiceDialog();

    // One search box covering both series and movies
    $field('content-search-input').oninput = debounce((e) => searchContent(e.target.value.trim()), 500);
}

// --- Boot ---
function init() {
    setupControls();
    setupDelegation();
    setupFilters();
    setupProxyForm();
    enhanceSelects();
    updatePauseButton();
    startTimer();

    // One Escape handler for every dismissible layer, innermost first
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (isDropdownOpen()) return closeDropdown();

        // Same as pressing Cancel, so a child dialog returns to its menu
        const modal = topmostModal();
        if (modal) return closeModalReturning(modal.id);
    });

    fetchData(); // Initial load runs even though auto-refresh starts paused
}

init();
