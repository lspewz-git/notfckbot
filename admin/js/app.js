/** Entry point: navigation, the refresh timer, and all event wiring. */

import { $, $field, all, closest, setText, debounce, target } from './dom.js';
import { fetchData, setSection } from './data.js';
import { setupFilters } from './tables.js';
import { filterLogs } from './logs.js';
import { openModal, closeModal, closeModalReturning } from './ui.js';
import { enhanceSelects, closeDropdown } from './select.js';
import { setupProxyForm, openProxyModal } from './proxy.js';
import { openChatActions, searchContent, selectContent, submitAddContent } from './chats.js';
import { openSeriesDetails, openModeModal, deleteSub, deleteWatchlistItem } from './records.js';
import { triggerCheck, openBroadcastModal, sendBroadcast, confirmWipeAll } from './maintenance.js';

const MOBILE_BREAKPOINT = 1024;
const REFRESH_SECONDS = 10;

// --- Navigation ---
let closeNav = null;

function switchSection(id) {
    setSection(id);
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `${id}-section`));
    all('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.section === id));
    fetchData();
}

/** Below MOBILE_BREAKPOINT the sidebar is an off-canvas drawer. */
function setupNav() {
    const sidebar = document.querySelector('.sidebar');
    const toggle = $('nav-toggle');
    const backdrop = $('nav-backdrop');
    if (!sidebar || !toggle || !backdrop) return;

    const setOpen = (open) => {
        sidebar.classList.toggle('open', open);
        backdrop.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', String(open));
    };
    closeNav = () => setOpen(false);

    toggle.onclick = () => setOpen(!sidebar.classList.contains('open'));
    backdrop.onclick = closeNav;

    // Picking a section or an action should get the drawer out of the way
    sidebar.querySelectorAll('.nav-item, .btn').forEach((el) => el.addEventListener('click', closeNav));

    // Back on a wide screen the sidebar is permanent again
    window.addEventListener('resize', () => {
        if (window.innerWidth > MOBILE_BREAKPOINT) setOpen(false);
    });
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
    proxy: () => openProxyModal()
};

const DELEGATED = '[data-action], [data-section], [data-close], [data-close-return], [data-log-filter]';

function setupDelegation() {
    document.addEventListener('click', (e) => {
        const el = closest(e, DELEGATED);
        if (!el) return;

        const { action, section, close, closeReturn, logFilter } = el.dataset;

        if (action && CLICK_ACTIONS[action]) CLICK_ACTIONS[action](el);
        if (section) switchSection(section);
        if (close) closeModal(close);
        if (closeReturn) closeModalReturning(closeReturn);
        if (logFilter) filterLogs(logFilter);
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

    // One search box covering both series and movies
    $field('content-search-input').oninput = debounce((e) => searchContent(e.target.value.trim()), 500);
}

// --- Boot ---
function init() {
    setupControls();
    setupDelegation();
    setupFilters();
    setupNav();
    setupProxyForm();
    enhanceSelects();
    updatePauseButton();
    startTimer();

    // One Escape handler for every dismissible layer
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeDropdown();
        if (closeNav) closeNav();
    });

    fetchData(); // Initial load runs even though auto-refresh starts paused
}

init();
