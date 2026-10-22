/** Entry point: navigation, the refresh timer, and all event wiring. */

import { $, $field, all, closest, debounce } from './dom.js';
import { runCheckNow, openFailingService } from './dashboard.js';
import { fetchData, setSection } from './data.js';
import { setSubsChart } from './dashboard-charts.js';
import { setupFilters, setTableTab, setTableSort, setTablePage } from './tables.js';
import { fillPagers } from './pager.js';
import { filterLogs } from './logs.js';
import { setHistoryYear, setHistoryPage, setupHistory } from './history.js';
import { settingsActions, setupSettings, hasUnsavedSettings, discardSettings } from './settings.js';
import { openModal, closeModal, closeModalReturning, topmostModal, setReturnTo, showConfirm } from './ui.js';
import { enhanceSelects, closeDropdown, isDropdownOpen } from './select.js';
import { setupProxyForm, openProxyModal } from './proxy.js';
import { openServiceModal, setupServiceDialog } from './services.js';
import {
    openChatActions,
    openAddContentFor,
    searchContent,
    selectContent,
    submitAddContent,
    setupChatSettingsForm
} from './chats.js';
import {
    openSeriesDetails,
    openFilmDetails,
    openModeModal,
    openSubActions,
    deleteSub,
    deleteWatchlistItem
} from './records.js';
import { triggerCheck, openBroadcastModal, sendBroadcast } from './maintenance.js';
import { openAbout, loadAbout } from './about.js';
import { openTestNotifyModal, setupTestNotifyDialog, selectSearchSeries } from './test-notify.js';

const REFRESH_SECONDS = 10;

// --- Navigation ---

let activeSection = 'dashboard';

function switchSection(id) {
    // Leaving Settings with changes not saved: ask, rather than lose them silently
    if (activeSection === 'settings' && id !== 'settings' && hasUnsavedSettings()) {
        showConfirm({
            title: 'Leave without saving?',
            text: 'The changes in Settings will be lost.',
            confirmLabel: 'Discard changes',
            cancelLabel: 'Stay',
            onConfirm: () => {
                discardSettings();
                switchSection(id);
            }
        });
        return;
    }
    activeSection = id;
    setSection(id);
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `${id}-section`));
    // Each section opens at its top: the page keeps one scroll position for all of them, and the
    // last section's would leave the new one scrolled down (or at the bottom, if it is shorter)
    window.scrollTo(0, 0);
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

// --- Auto-refresh ---
// Off by default; the choice is remembered in this browser
const AUTO_REFRESH_KEY = 'admin.autoRefresh';
let secondsLeft = REFRESH_SECONDS;
let isPaused = true;
try {
    isPaused = localStorage.getItem(AUTO_REFRESH_KEY) !== 'on';
} catch {
    // Private mode: start paused
}

function updateAutoRefreshSwitch() {
    const sw = $('auto-refresh');
    if (sw) sw.setAttribute('aria-checked', String(!isPaused));
    renderCountdown();
}

/** "7 s" next to the switch while it is on: shows that it is counting, and to when. */
function renderCountdown() {
    const el = $('refresh-countdown');
    if (el) el.textContent = isPaused ? '' : `${secondsLeft} s`;
}

// A refresh is usually over in a blink; the turn of the icon should still be seen
const MIN_SPIN_MS = 600;

// The refresh in progress, if any: a click or a timer tick during it joins it instead of
// starting a second one, so requests don't double and the icon stops only at the real end
let refreshing = null;

/** Reloads what is on screen, turning the refresh icon meanwhile; restarts the countdown. */
function refreshNow() {
    secondsLeft = REFRESH_SECONDS;
    renderCountdown();
    if (refreshing) return refreshing;

    const btn = $('refresh-btn');
    btn.classList.add('spinning');
    refreshing = Promise.all([fetchData(), new Promise((r) => setTimeout(r, MIN_SPIN_MS))]).finally(() => {
        btn.classList.remove('spinning');
        refreshing = null;
    });
    return refreshing;
}

function startTimer() {
    setInterval(() => {
        if (isPaused) return;
        secondsLeft--;
        if (secondsLeft <= 0) refreshNow();
        else renderCountdown();
    }, 1000);
}

// --- Event delegation ---
// Generated markup carries data-* attributes only, so nothing has to be
// reachable from the global scope and no value ends up inside executable code.
const CLICK_ACTIONS = {
    'chat-actions': (el) => openChatActions(el.dataset.id),
    series: (el) => openSeriesDetails(el.dataset.id),
    film: (el) => openFilmDetails(el.dataset.id),
    mode: (el) => openModeModal(el.dataset.key),
    'sub-actions': (el) => openSubActions(el.dataset.key),
    'delete-sub': (el) => deleteSub(el.dataset.chat, el.dataset.series),
    'delete-film': (el) => deleteWatchlistItem(el.dataset.id),
    sort: (el) => setTableSort(el.dataset.table, el.dataset.sort),
    page: (el) => setTablePage(el.dataset.table, Number(el.dataset.step)),
    'select-content': (el) => selectContent(Number(el.dataset.index)),
    'add-content': (el) => openAddContentFor(el.dataset.kind === 'tv' ? 'tv' : 'movie'),
    'history-year': (el) => setHistoryYear(Number(el.dataset.year)),
    'history-page': (el) => setHistoryPage(el.dataset.list, Number(el.dataset.step)),
    ...settingsActions,
    'chart-subs': (el) => setSubsChart(el.dataset.by),
    'select-test-search-series': (el) => selectSearchSeries(Number(el.dataset.index)),
    proxy: () => openProxyModal(),
    about: () => loadAbout(),
    service: (el) =>
        openServiceModal(el.dataset.service, {
            label: el.dataset.label,
            restarts: el.dataset.restarts === 'true',
            statusUrl: el.dataset.statusUrl,
            statusLabel: el.dataset.statusLabel
        })
};

const DELEGATED =
    '[data-action], [data-section], [data-close], [data-close-return], [data-open], [data-log-filter], [data-subs-tab], [data-films-tab]';

function setupDelegation() {
    document.addEventListener('click', (e) => {
        const el = closest(e, DELEGATED);
        if (!el) return;

        const { action, section, close, closeReturn, open, logFilter, subsTab, filmsTab } = el.dataset;

        if (action && CLICK_ACTIONS[action]) CLICK_ACTIONS[action](el);
        // Before the section switch, so the dashboard card lands on the right tab
        if (subsTab) setTableTab('subs', subsTab);
        if (filmsTab) setTableTab('films', filmsTab);
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
    $('auto-refresh').onclick = () => {
        isPaused = !isPaused;
        if (!isPaused) secondsLeft = REFRESH_SECONDS;
        try {
            localStorage.setItem(AUTO_REFRESH_KEY, isPaused ? 'off' : 'on');
        } catch {
            // Private mode: the choice just isn't remembered
        }
        updateAutoRefreshSwitch();
    };
    $('run-check').onclick = () => runCheckNow(fetchData);
    $('service-alert-action').onclick = openFailingService;

    $('refresh-btn').onclick = refreshNow;

    $('actions-btn').onclick = () => openModal('actions-modal');
    $('about-btn').onclick = openAbout;
    $('trigger-btn').onclick = triggerCheck;
    $('broadcast-btn').onclick = openBroadcastModal;
    $('test-notify-btn').onclick = () => {
        closeModal('actions-modal');
        setReturnTo(() => openModal('actions-modal'));
        openTestNotifyModal();
    };
    $('send-broadcast').onclick = sendBroadcast;
    $('confirm-add-content').onclick = submitAddContent;
    setupServiceDialog();
    setupTestNotifyDialog();

    // One search box covering both series and movies
    $field('content-search-input').oninput = debounce((e) => searchContent(e.target.value.trim()), 500);
}

// --- Boot ---
function init() {
    // First: the selects inside are what setupFilters, setupHistory and enhanceSelects work on
    fillPagers();
    setupControls();
    setupDelegation();
    setupFilters();
    // Before enhanceSelects(), like setupFilters: the styled dropdowns start on the remembered size
    setupHistory();
    setupSettings();
    setupChatSettingsForm();
    setupProxyForm();
    enhanceSelects();
    updateAutoRefreshSwitch();
    startTimer();

    // One Escape handler for every dismissible layer, innermost first
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // Handled here: the browser's own Escape would close the dialog under an open list too
        if (isDropdownOpen()) {
            e.preventDefault();
            return closeDropdown();
        }

        // Same as pressing Cancel, so a child dialog returns to its menu
        const modal = topmostModal();
        if (modal) {
            e.preventDefault();
            return closeModalReturning(modal.id);
        }
    });

    fetchData(); // Initial load runs even though auto-refresh starts paused
}

init();
