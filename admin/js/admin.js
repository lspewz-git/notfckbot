/** Administrative screens are loaded only after an administrator signs in. */
import { t as i18nText } from './i18n.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { fetchData } from './data.js';
import { openModal, closeModal, setReturnTo } from './ui.js';
import {
    runCheckNow,
    openFailingService,
    updateStats,
    updateHealth,
    updatePopular,
    updateUpcoming,
    updateCron,
    statsFailed,
    listFailed
} from './dashboard.js';
import { setSubsChart, openRecentSends, updateCharts, chartsFailed } from './dashboard-charts.js';
import {
    setupFilters,
    setTableTab,
    setTableSort,
    setTablePage,
    renderTable,
    renderSkeleton,
    renderTableMessage
} from './tables.js';
import { filterLogs, setLogs, renderLogs } from './logs.js';
import { loadHistory } from './history.js';
import { pickPeriod, confirmSendOne } from './chat-stats.js';
import { openRecapSend, pickRecapYear, confirmSendAll, stopRecapSend } from './recap.js';
import { recapCardActions, setupRecapCards, openRecapSection, recapSendYear } from './recap-cards.js';
import { recapScheduleActions, setupRecapSchedule } from './recap-schedule.js';
import { settingsActions, setupSettings, hasUnsavedSettings, discardSettings, loadSettings } from './settings.js';
import { accessActions, setupAccess, loadAccess } from './access.js';
import { alertsActions, setupAlerts, loadAlerts } from './alerts.js';
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
import { triggerCheck, openBroadcastModal, sendBroadcast } from './maintenance.js';
import { openTestNotifyModal, setupTestNotifyDialog, selectSearchSeries } from './test-notify.js';
import { setupSearchForms } from './content-search.js';

export { hasUnsavedSettings, discardSettings, setTableTab, filterLogs, openRecapSection };
export const adminActions = {
    'chat-actions': (el) => openChatActions(el.dataset.id),
    sort: (el) => setTableSort(el.dataset.table, el.dataset.sort),
    page: (el) => setTablePage(el.dataset.table, Number(el.dataset.step)),
    'content-chat-open': () => openContentChats(),
    'select-content': (el) => selectContent(Number(el.dataset.index)),
    'add-content-film': (el) => selectContent(Number(el.dataset.index), true),
    'submit-content': () => submitAddContent(),
    'add-content': (el) => openAddContentFor(el.dataset.kind === 'tv' ? 'tv' : 'movie'),
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
    'chart-subs': (el) => setSubsChart(el.dataset.by),
    'sends-recent': () => openRecentSends(),
    'select-test-search-series': (el) => selectSearchSeries(Number(el.dataset.index)),
    proxy: () => openProxyModal(),
    service: (el) =>
        openServiceModal(el.dataset.service, {
            label: el.dataset.label,
            restarts: el.dataset.restarts === 'true',
            keyless: el.dataset.keyless === 'true',
            statusUrl: el.dataset.statusUrl,
            statusLabel: el.dataset.statusLabel
        })
};

export function setupAdmin() {
    setupFilters();
    setupSettings();
    setupAccess();
    setupAlerts();
    setupRecapCards();
    setupRecapSchedule();
    setupChatSettingsForm();
    setupProxyForm();
    setupServiceDialog();
    setupTestNotifyDialog();
    setupSearchForms({ admin: searchContent });
    $('run-check').onclick = () => runCheckNow(fetchData);
    $('service-alert-action').onclick = openFailingService;
    $('trigger-btn').onclick = triggerCheck;
    $('broadcast-btn').onclick = openBroadcastModal;
    $('test-notify-btn').onclick = () => {
        closeModal('actions-modal');
        setReturnTo(() => openModal('actions-modal'));
        openTestNotifyModal();
    };
    $('send-broadcast').onclick = sendBroadcast;
}

const SECTION_TABLES = { chats: 'chats', subs: 'subs', watchlist: 'films' };
const loadedTables = new Set();
const tableRequests = new Map();
const orElse = (fallback) => (err) => {
    fallback();
    throw err;
};

async function fetchTypedData(type) {
    const request = (tableRequests.get(type) || 0) + 1;
    tableRequests.set(type, request);
    if (!loadedTables.has(type)) renderSkeleton(type);
    try {
        const data = await api(`/data/${type}`);
        if (tableRequests.get(type) !== request) return;
        loadedTables.add(type);
        renderTable(type, data);
    } catch (err) {
        if (tableRequests.get(type) !== request) return;
        console.error(i18nText('Error loading {{v0}}:', { v0: type }), err);
        if (!loadedTables.has(type))
            renderTableMessage(type, i18nText('Failed to load. Retrying on the next refresh.'));
    }
}

export async function fetchAdminData(section) {
    const jobs = [];
    if (SECTION_TABLES[section]) jobs.push(fetchTypedData(SECTION_TABLES[section]));
    if (section === 'dashboard') {
        jobs.push(api('/stats').then(updateStats, orElse(statsFailed)));
        jobs.push(api('/stats/charts').then(updateCharts, orElse(chartsFailed)));
        for (const service of ['telegram', 'tmdb', 'tvmaze', 'kinopoisk', 'proxy'])
            jobs.push(api(`/health/${service}`).then(updateHealth));
        jobs.push(
            api('/stats/popular').then(
                updatePopular,
                orElse(() => listFailed('popular-list'))
            )
        );
        jobs.push(
            api('/upcoming').then(
                updateUpcoming,
                orElse(() => listFailed('upcoming-list'))
            )
        );
        jobs.push(api('/cron').then(updateCron));
    }
    if (section === 'history') jobs.push(loadHistory());
    if (section === 'settings') jobs.push(loadSettings(), loadAlerts(), loadAccess());
    if (section === 'logs')
        jobs.push(
            api('/logs').then((logs) => {
                setLogs(logs);
                renderLogs();
            })
        );
    const results = await Promise.allSettled(jobs);
    for (const result of results)
        if (result.status === 'rejected') console.error(i18nText('Fetch error:'), result.reason);
}
