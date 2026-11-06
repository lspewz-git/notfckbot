/** Entry point: navigation, the refresh timer, and all event wiring. */

import { $, all, closest } from './dom.js';
import { runCheckNow, openFailingService } from './dashboard.js';
import { fetchData, setSection } from './data.js';
import { setSubsChart, openRecentSends } from './dashboard-charts.js';
import { setupFilters, setTableTab, setTableSort, setTablePage } from './tables.js';
import { fillPagers } from './pager.js';
import { filterLogs } from './logs.js';
import { setHistoryYear, setHistoryPage, setupHistory, openHistoryTitle } from './history.js';
import { pickPeriod, confirmSendOne } from './chat-stats.js';
import { openRecapSend, pickRecapYear, confirmSendAll, stopRecapSend } from './recap.js';
import { recapCardActions, setupRecapCards, openRecapSection, recapSendYear } from './recap-cards.js';
import { recapScheduleActions, setupRecapSchedule } from './recap-schedule.js';
import { settingsActions, setupSettings, hasUnsavedSettings, discardSettings } from './settings.js';
import { accessActions, setupAccess } from './access.js';
import { alertsActions, setupAlerts } from './alerts.js';
import {
    openModal,
    closeModal,
    closeModalReturning,
    dismissChatModals,
    dismissTopLayer,
    setReturnTo,
    showConfirm,
    setupKeyboardWatch
} from './ui.js';
import { enhanceSelects } from './select.js';
import { setupProxyForm, openProxyModal } from './proxy.js';
import { openServiceModal, setupServiceDialog } from './services.js';
import {
    openChatActions,
    openAddContentFor,
    openContentChats,
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
import { accountActions, setupAccount, searchAccount } from './account.js';
import { startSession, watchSession, sessionActions, launchedInChat } from './session.js';
import { passwordActions, setupPassword } from './password.js';
import { setupPullRefresh } from './pull-refresh.js';
import { pickActions } from './pick-sheet.js';
import { profileActions, setupProfile } from './profile.js';
import { titleCardActions, setupPosterViewer } from './title-card.js';
import { deviceActions } from './devices.js';
import { setupSearchForms, toggleDescription } from './content-search.js';
import { chatPickerActions } from './chat-picker.js';
import { setupNavigation } from './navigation.js';
import { syncTelegramBack } from './tg-back.js';

const REFRESH_SECONDS = 10;

// --- Navigation ---

let activeSection = 'dashboard';

// An admin has two views: the admin panel and "My account" (their own chats, what a user sees).
// The open section sets the view; each view reopens on the section it was left on
const viewOf = (id) => (id.startsWith('my-') && !document.body.classList.contains('system-account') ? 'mine' : 'admin');
const lastSection = { admin: 'dashboard', mine: 'my-subs' };
// Opened from the Account tab, not tabs of their own: a view never reopens on them
const ACCOUNT_PAGES = ['my-account', 'my-settings', 'my-devices', 'my-search'];
// The local account has its Account page and profile settings, but no Telegram chat pages
const SYSTEM_PAGES = ['my-profile', 'my-account', 'my-devices'];

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
    if (!ACCOUNT_PAGES.includes(id)) lastSection[viewOf(id)] = id;
    document.body.classList.toggle('view-mine', viewOf(id) === 'mine');
    setSection(id);
    // The section goes into the address, so a reload (or a shared link) opens it again. Replaced,
    // not pushed: Back still leaves the panel instead of stepping through its tabs
    window.history.replaceState(null, '', `#${id}`);
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `${id}-section`));
    syncTelegramBack();
    // Each section opens at its top: the page keeps one scroll position for all of them, and the
    // last section's would leave the new one scrolled down (or at the bottom, if it is shorter)
    window.scrollTo(0, 0);
    // Sidebar items and tab-bar items; "More" counts as active for the sections it holds
    all('.nav-item, .tab-item').forEach((n) => {
        const own = n.dataset.section === id;
        const on = own || (n.dataset.tabSections || '').split(' ').includes(id);
        n.classList.toggle('active', on);
        // Screen readers announce the current section, not just a coloured row: "page" on the section
        // itself, "true" on the tab holding a nested page (Account for Devices)
        if (on) n.setAttribute('aria-current', own ? 'page' : 'true');
        else n.removeAttribute('aria-current');
    });
    if (id === 'recap') openRecapSection();
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
    'description-toggle': toggleDescription,
    'chat-actions': (el) => openChatActions(el.dataset.id),
    'view-admin': () => switchSection(lastSection.admin),
    'view-mine': () => switchSection(lastSection.mine),
    series: (el) => openSeriesDetails(el.dataset.id, el),
    film: (el) => openFilmDetails(el.dataset.id, el),
    mode: (el) => openModeModal(el.dataset.key),
    'sub-actions': (el) => openSubActions(el.dataset.key),
    'delete-sub': (el) => deleteSub(el.dataset.chat, el.dataset.series),
    'delete-film': (el) => deleteWatchlistItem(el.dataset.id),
    sort: (el) => setTableSort(el.dataset.table, el.dataset.sort),
    page: (el) => setTablePage(el.dataset.table, Number(el.dataset.step)),
    'content-chat-open': () => openContentChats(),
    'select-content': (el) => selectContent(Number(el.dataset.index)),
    'add-content-film': (el) => selectContent(Number(el.dataset.index), true),
    'submit-content': () => submitAddContent(),
    'add-content': (el) => openAddContentFor(el.dataset.kind === 'tv' ? 'tv' : 'movie'),
    'history-open': openHistoryTitle,
    'history-year': (el) => setHistoryYear(Number(el.dataset.year), el),
    'history-page': (el) => setHistoryPage(el.dataset.list, Number(el.dataset.step), el),
    'chat-stats-period': (el) => pickPeriod(el.dataset.period),
    'recap-send-one': (el) => confirmSendOne(el.dataset.again === 'true'),
    'recap-send-open': () => {
        const year = recapSendYear();
        if (year !== null) openRecapSend(year);
    },
    'recap-send-year': (el) => pickRecapYear(el.dataset.year),
    'recap-send-all': () => confirmSendAll(),
    'recap-send-stop': () => stopRecapSend(),
    ...settingsActions,
    ...accessActions,
    ...alertsActions,
    ...recapCardActions,
    ...recapScheduleActions,
    ...accountActions,
    ...passwordActions,
    ...pickActions,
    ...chatPickerActions,
    ...profileActions,
    ...deviceActions,
    ...titleCardActions,
    ...sessionActions(afterSignIn),
    'chart-subs': (el) => setSubsChart(el.dataset.by),
    'sends-recent': () => openRecentSends(),
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
    '[data-action], [data-section], [data-close], [data-close-return], [data-open], [data-log-filter], [data-subs-tab], [data-films-tab], [data-chats-tab]';

function setupDelegation() {
    document.addEventListener('click', (e) => {
        const el = closest(e, DELEGATED);
        if (!el) return;

        const { action, section, close, closeReturn, open, logFilter, subsTab, filmsTab, chatsTab } = el.dataset;

        // A tab bar link switches the section here: its own navigation would push a history entry
        if (section && el.tagName === 'A') {
            // Ctrl/Cmd/Shift-click: the browser opens the section in a new tab or window
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
        }
        if (action && CLICK_ACTIONS[action]) CLICK_ACTIONS[action](el);
        // Before the section switch, so the dashboard card lands on the right tab
        if (subsTab) setTableTab('subs', subsTab);
        if (filmsTab) setTableTab('films', filmsTab);
        if (chatsTab) setTableTab('chats', chatsTab);
        if (section) switchSection(section);
        // A dialog's cross (a sheet's too, not the poster's) ends the whole chat action flow
        const cross =
            el.classList.contains('modal-x') || (el.classList.contains('sheet-close') && close !== 'poster-modal');
        if (close && !(cross && dismissChatModals())) closeModal(close);
        if (closeReturn) closeModalReturning(closeReturn);
        // After any close, so a menu row can swap its sheet for the dialog it names
        if (open) openModal(open);
        if (logFilter) filterLogs(logFilter);
    });

    // A click on the dimmed backdrop dismisses the dialog. The press must also
    // start there: dragging a text selection out of a field ends the click on the backdrop too.
    let pressedBackdrop = null;
    document.addEventListener('mousedown', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        pressedBackdrop = t.classList && t.classList.contains('modal') ? t : null;
    });
    document.addEventListener('click', (e) => {
        if (pressedBackdrop && e.target === pressedBackdrop && !dismissChatModals())
            closeModalReturning(pressedBackdrop.id);
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
    setupPullRefresh(refreshNow);
    setupKeyboardWatch();

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

    setupServiceDialog();
    setupTestNotifyDialog();

    setupSearchForms({ admin: searchContent, account: searchAccount });
}

// --- Boot ---

/** The section named in the address, if this role may open it; null otherwise. */
function sectionFromHash(role) {
    const id = location.hash.slice(1);
    if (!/^[a-z-]+$/.test(id) || !document.getElementById(`${id}-section`)) return null;
    // Local accounts have profile settings, but no Telegram chat pages.
    if (id.startsWith('my-'))
        return document.body.classList.contains('system-account') && !SYSTEM_PAGES.includes(id) ? null : id;
    return role === 'admin' ? id : null;
}

/**
 * Once signed in: the section in the address (a reload keeps the tab), else an admin's panel opens
 * on the dashboard and a user's on their subscriptions.
 */
function afterSignIn(role) {
    // Opened from a group (a Mini App or a group's sign-in link): that chat's subscriptions
    const start = launchedInChat() ? 'my-subs' : role === 'admin' ? activeSection : 'my-subs';
    switchSection(sectionFromHash(role) || start);
}

async function init() {
    setupNavigation();
    // First: the selects inside are what setupFilters, setupHistory and enhanceSelects work on
    fillPagers();
    setupControls();
    setupDelegation();
    setupFilters();
    // Before enhanceSelects(), like setupFilters: the styled dropdowns start on the remembered size
    setupHistory();
    setupSettings();
    setupAccess();
    setupAlerts();
    setupRecapCards();
    setupRecapSchedule();
    setupChatSettingsForm();
    setupProxyForm();
    setupAccount();
    setupProfile();
    setupPosterViewer();
    setupPassword();
    watchSession();
    enhanceSelects();
    updateAutoRefreshSwitch();
    startTimer();

    // One Escape handler for every dismissible layer, innermost first
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // Handled here: the browser's own Escape would close the dialog under an open list too
        if (dismissTopLayer()) e.preventDefault();
    });

    // Who is signed in first: the sign-in screen, an admin's panel or a user's own chats. The initial
    // load runs even though auto-refresh starts paused
    const role = await startSession();
    if (role) afterSignIn(role);
}

init();
