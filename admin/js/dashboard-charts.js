/**
 * The dashboard's two charts, drawn by Chart.js (admin/vendor/chart.umd.js, loaded before the
 * modules as the global `Chart`): new subscriptions by week or month, and notifications by day.
 * Colours come from the design tokens, so the charts follow the panel's theme.
 */

import { $, all } from './dom.js';
import { isUnchanged } from './render.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const monthLabel = (month) => MONTHS[Number(month.slice(5, 7)) - 1];

/** @type {{ weeks: { start: string, count: number }[], months: { month: string, count: number }[], days: { day: string, sent: number, failed: number }[], countingSince: string } | null} */
let data = null;
let subsBy = 'weeks';
/** @type {Record<string, any>} */
const charts = {};

const ChartJs = () => /** @type {any} */ (window).Chart;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function options(stacked) {
    const dim = token('--text-dim');
    return {
        responsive: true,
        maintainAspectRatio: false,
        // Redrawn on every refresh: an animation each time would only flicker
        animation: false,
        plugins: {
            legend: { display: stacked, position: 'bottom', labels: { color: dim, boxWidth: 10, boxHeight: 10 } },
            tooltip: { backgroundColor: token('--surface-3'), titleColor: token('--text'), bodyColor: token('--text') }
        },
        scales: {
            x: {
                stacked,
                grid: { display: false },
                ticks: { color: dim, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
            },
            y: {
                stacked,
                beginAtZero: true,
                ticks: { color: dim, precision: 0, maxTicksLimit: 5 },
                grid: { color: token('--border') },
                border: { display: false }
            }
        }
    };
}

/** Draws a chart the first time, then only swaps its data. */
function draw(id, chartData, stacked) {
    if (charts[id]) {
        charts[id].data = chartData;
        charts[id].update('none');
        return;
    }
    charts[id] = new (ChartJs())($(id), { type: 'bar', data: chartData, options: options(stacked) });
}

function renderSubs() {
    const rows = subsBy === 'months' ? data.months : data.weeks;
    draw(
        'chart-subs',
        {
            labels: rows.map((r) => ('start' in r ? dayLabel(r.start) : monthLabel(r.month))),
            datasets: [
                {
                    label: 'New subscriptions',
                    data: rows.map((r) => r.count),
                    backgroundColor: token('--accent'),
                    borderRadius: 3,
                    maxBarThickness: 28
                }
            ]
        },
        false
    );
    $('chart-subs').setAttribute('aria-label', `New subscriptions per ${subsBy === 'months' ? 'month' : 'week'}`);
}

function renderSent() {
    draw(
        'chart-sent',
        {
            labels: data.days.map((d) => dayLabel(d.day)),
            datasets: [
                {
                    label: 'Sent',
                    data: data.days.map((d) => d.sent),
                    backgroundColor: token('--text-secondary'),
                    borderRadius: 2,
                    maxBarThickness: 16
                },
                {
                    label: 'Not delivered',
                    data: data.days.map((d) => d.failed),
                    backgroundColor: token('--danger'),
                    borderRadius: 2,
                    maxBarThickness: 16
                }
            ]
        },
        true
    );
    // The bot counts from the day this was deployed: earlier days are not zeros but unknown
    const since = data.countingSince;
    $('chart-sent-note').textContent = since > data.days[0].day ? `Counting since ${dayLabel(since)}` : 'Last 30 days';
}

/** New data from /api/stats/charts; nothing to do without Chart.js (its file didn't load). */
export function updateCharts(next) {
    if (!ChartJs() || isUnchanged('charts', next)) return;
    data = next;
    renderSubs();
    renderSent();
}

/** The Weeks / Months buttons. */
export function setSubsChart(by) {
    if (by !== 'weeks' && by !== 'months') return;
    subsBy = by;
    all('[data-action="chart-subs"]').forEach((el) => {
        const on = /** @type {HTMLElement} */ (el).dataset.by === by;
        el.classList.toggle('active', on);
        el.setAttribute('aria-pressed', String(on));
    });
    if (data && ChartJs()) renderSubs();
}
