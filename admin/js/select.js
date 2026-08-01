/**
 * Custom dropdowns.
 *
 * The native <select> popup is drawn by the OS and ignores our CSS, so the real
 * element stays in the DOM (hidden) and a styled button plus a fixed-position
 * panel drive it. Reading `el.value` keeps working everywhere.
 */

import { $field, escapeHtml } from './dom.js';

let openDropdown = null;

export function closeDropdown() {
    if (!openDropdown) return;
    openDropdown.panel.remove();
    openDropdown.trigger.setAttribute('aria-expanded', 'false');
    openDropdown = null;
}

/** Set a value programmatically and let the styled trigger catch up. */
export function setSelectValue(id, value) {
    const el = $field(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function enhanceSelect(select) {
    const wrap = document.createElement('div');
    wrap.className = 'custom-select';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    // Drop .select-field so a second pass won't wrap this element again
    select.classList.remove('select-field');
    select.classList.add('custom-select-native');
    select.tabIndex = -1;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-field custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    wrap.appendChild(trigger);

    const syncLabel = () => {
        const opt = select.options[select.selectedIndex];
        trigger.innerText = opt ? opt.text : '';
    };
    syncLabel();
    select.addEventListener('change', syncLabel);

    const openPanel = () => {
        const panel = document.createElement('div');
        panel.className = 'custom-select-panel';
        panel.setAttribute('role', 'listbox');
        panel.onclick = (e) => e.stopPropagation();

        Array.from(select.options).forEach((opt, idx) => {
            const isSelected = idx === select.selectedIndex;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `custom-select-option${isSelected ? ' selected' : ''}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(isSelected));
            row.innerHTML =
                `<span>${escapeHtml(opt.text)}</span>` +
                (isSelected ? '<span class="custom-select-check">✓</span>' : '');
            row.onclick = () => {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                closeDropdown();
                trigger.focus();
            };
            panel.appendChild(row);
        });

        document.body.appendChild(panel);

        // Fixed positioning keeps the panel out of the modal's overflow clipping
        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        panel.style.width = `${rect.width}px`;
        panel.style.left = `${rect.left}px`;
        panel.style.top =
            spaceBelow < panel.offsetHeight + 12 && rect.top > spaceBelow
                ? `${rect.top - panel.offsetHeight - 6}px`
                : `${rect.bottom + 6}px`;

        trigger.setAttribute('aria-expanded', 'true');
        openDropdown = { trigger, panel };

        const first = /** @type {HTMLElement} */ (panel.querySelector('.selected') || panel.firstElementChild);
        if (first) first.focus();
    };

    trigger.onclick = (e) => {
        e.stopPropagation();
        const wasOpen = openDropdown && openDropdown.trigger === trigger;
        closeDropdown();
        if (!wasOpen) openPanel();
    };
}

export function enhanceSelects() {
    document.querySelectorAll('select.select-field').forEach(enhanceSelect);

    document.addEventListener('click', closeDropdown);
    window.addEventListener('resize', closeDropdown);
    window.addEventListener('scroll', closeDropdown, true);
}
