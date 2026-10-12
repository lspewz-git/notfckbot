/** Sortable columns: the chosen key and direction per table, and the header buttons that show it. */

import { all } from './dom.js';
import { TABLES } from './table-defs.js';

// Per table: { key, dir }, or absent for the API's order
const sortState = {};

/** `rows` in the table's chosen order; as given when none is chosen. */
export function sortRows(type, rows) {
    const state = sortState[type];
    const value = state && TABLES[type].sorts[state.key];
    if (!value) return rows;
    const sign = state.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        // Unknown values (TBA, no year) stay at the bottom either way
        if (va === null || vb === null) return Number(va === null) - Number(vb === null);
        return va < vb ? -sign : va > vb ? sign : 0;
    });
}

function updateSortButtons(type) {
    const state = sortState[type];
    all(`[data-action="sort"][data-table="${type}"]`).forEach((btn) => {
        const on = Boolean(state) && state.key === btn.dataset.sort;
        btn.classList.toggle('active', on);
        btn.dataset.dir = on ? state.dir : '';
        const label = btn.innerText.trim();
        btn.setAttribute(
            'aria-label',
            on ? `${label}, sorted ${state.dir === 'asc' ? 'ascending' : 'descending'}` : `Sort by ${label}`
        );
        const th = btn.closest('th');
        if (th) th.setAttribute('aria-sort', on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
}

/**
 * First click sorts ascending, the next descending, the third restores the API's order.
 * False when the table can't be sorted by `key`.
 */
export function toggleSort(type, key) {
    const table = TABLES[type];
    if (!table || !table.sorts || !table.sorts[key]) return false;
    const state = sortState[type];
    if (!state || state.key !== key) sortState[type] = { key, dir: 'asc' };
    else if (state.dir === 'asc') state.dir = 'desc';
    else delete sortState[type];
    updateSortButtons(type);
    return true;
}
