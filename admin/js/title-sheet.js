/** Layout and phone gestures shared by every title-card entry point. */
import { closeModalReturning, dismissChatModals, topmostModal } from './ui.js';

const layouts = new WeakMap();
const copies = new WeakMap();
const pixels = (value) => Number.parseFloat(value) || 0;
// Entry animations scale the frame; layout measurements must not include that transform.
const height = (element) => element.offsetHeight;

/** Keep the frame fixed; expanded details and actions share the same scrolling flow. */
export function fitTitleSheet(root) {
    const sheet = /** @type {HTMLElement | null} */ (
        root.matches?.('.title-sheet') ? root : root.querySelector('.title-sheet')
    );
    const modal = /** @type {HTMLDialogElement | null} */ (sheet?.closest('dialog'));
    if (!sheet || !modal?.open) return;
    const scroll = /** @type {HTMLElement} */ (sheet.querySelector('.tc-scroll'));
    if (!scroll) return;
    const scrollTop = scroll.scrollTop;
    let state = layouts.get(sheet);
    if (!state || state.scroll !== scroll) {
        state?.observer.disconnect();
        state = { scroll, width: 0, fixed: null, footer: null, observer: null, pending: false };
        layouts.set(sheet, state);
        state.observer = new window.ResizeObserver((entries) => {
            if (
                state.pending ||
                !entries.some((entry) => entry.target !== sheet || Math.abs(sheet.clientWidth - state.width) > 1)
            )
                return;
            // Changing an observed frame synchronously causes WebKit's delivery-loop error.
            state.pending = true;
            window.requestAnimationFrame(() => {
                state.pending = false;
                if (modal.open && layouts.get(sheet) === state) fitTitleSheet(sheet);
            });
        });
        for (const target of [sheet, ...sheet.querySelectorAll('.tc-head, .tc-footer, .tc-premieres, .tc-notify')])
            state.observer.observe(target);
        modal.addEventListener(
            'close',
            () => {
                if (modal.open) return;
                state.observer.disconnect();
                if (layouts.get(sheet) === state) layouts.delete(sheet);
            },
            { once: true }
        );
        setupSwipe(sheet, scroll, modal);
    }
    if (Math.abs(sheet.clientWidth - state.width) > 1) {
        state.width = sheet.clientWidth;
        state.fixed = state.footer = null;
    }
    for (const label of sheet.querySelectorAll('.tc-season-label')) {
        label.classList.remove('tc-no-calendar');
        const grid = label.closest('.tc-season-grid');
        if (
            grid.getAttribute('data-columns') === '3' &&
            label.querySelector('span').scrollWidth + 18 > label.clientWidth
        )
            label.classList.add('tc-no-calendar');
    }
    const style = getComputedStyle(sheet);
    const modalStyle = getComputedStyle(modal);
    const max = Math.min(
        pixels(style.maxHeight),
        modal.clientHeight - pixels(modalStyle.paddingTop) - pixels(modalStyle.paddingBottom)
    );
    const base = Math.min(max, Math.round((window.visualViewport?.height || window.innerHeight) * 0.9));
    const footer = /** @type {HTMLElement} */ (sheet.querySelector('.tc-footer'));
    const footerHeight = height(footer);
    state.footer ??= footerHeight;
    const description = /** @type {HTMLElement | null} */ (sheet.querySelector('.tc-description'));
    const children = [...scroll.children].filter((el) => !el.hasAttribute('hidden'));
    const gap = pixels(getComputedStyle(scroll).rowGap);
    let current = Math.max(0, children.length - 1) * gap;
    for (const child of children)
        if (child !== description && child !== footer) {
            const css = getComputedStyle(child);
            current += height(child) + pixels(css.marginTop) + pixels(css.marginBottom);
        }
    let collapsed = current;
    const notify = sheet.querySelector('.tc-notify');
    if (notify) collapsed -= height(notify) - height(notify.querySelector('.tc-notify-toggle'));
    const premieres = sheet.querySelector('.tc-premieres');
    if (premieres) {
        const first = premieres.querySelector('.tc-season');
        const more = premieres.querySelector('.tc-seasons-more');
        const seasonGap = pixels(getComputedStyle(premieres).rowGap);
        const firstRow =
            height(premieres.querySelector('h3')) + seasonGap + height(first) + (more ? seasonGap + height(more) : 0);
        collapsed -= height(premieres) - firstRow;
    }
    state.fixed ??= collapsed;
    const insets =
        pixels(style.paddingTop) +
        pixels(style.paddingBottom) +
        pixels(style.borderTopWidth) +
        pixels(style.borderBottomWidth);
    const room = Math.max(24, base - insets - state.footer - state.fixed);
    if (description) {
        const text = /** @type {HTMLElement} */ (description.querySelector('.tc-overview'));
        const copy = text.querySelector('.tc-copy');
        const tail = /** @type {HTMLElement} */ (text.querySelector('.tc-tail'));
        const ellipsis = /** @type {HTMLElement} */ (text.querySelector('.tc-ellipsis'));
        const more = /** @type {HTMLButtonElement} */ (text.querySelector('.tc-more'));
        if (!copies.has(copy)) copies.set(copy, copy.textContent);
        const full = copies.get(copy);
        copy.textContent = full;
        tail.hidden = true;
        const natural = text.scrollHeight;
        const expanded = more.getAttribute('aria-expanded') === 'true';
        const overflow = natural > room + 1;
        more.hidden = tail.hidden = !expanded && !overflow;
        ellipsis.hidden = expanded;
        if (expanded) copy.textContent = full + ' ';
        else if (overflow) {
            const chars = Array.from(full);
            const line = pixels(getComputedStyle(text).lineHeight);
            const available = Math.max(1, Math.floor(room / line)) * line;
            const prefix = (n) =>
                chars
                    .slice(0, n)
                    .join('')
                    .replace(/\s+\S*$/, '')
                    .trimEnd();
            let low = 0,
                high = chars.length;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                copy.textContent = prefix(mid);
                if (text.scrollHeight <= available + 1) low = mid;
                else high = mid - 1;
            }
            copy.textContent = prefix(low);
        }
        const used = expanded ? text.scrollHeight : room;
        description.style.height = `${used}px`;
    }
    sheet.style.height = `${base}px`;
    scroll.scrollTop = scrollTop;
}

/** The scrolling region and footer use one phone gesture, with a visible Close alternative. */
function setupSwipe(sheet, scroll, modal) {
    if (sheet.dataset.swipeReady) return;
    sheet.dataset.swipeReady = 'true';
    let drag = null;
    let returning = null;
    let blockClickUntil = 0;
    const reset = () => {
        returning?.cancel();
        returning = null;
        sheet.style.removeProperty('transform');
        drag = null;
    };
    const settle = () => {
        drag = null;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return reset();
        const from = getComputedStyle(sheet).transform;
        returning?.cancel();
        const animation = sheet.animate([{ transform: from }, { transform: 'translateY(0)' }], {
            duration: 280,
            easing: 'cubic-bezier(.2,.7,.3,1)',
            fill: 'forwards'
        });
        returning = animation;
        animation.finished.then(
            () => returning === animation && reset(),
            () => {}
        );
    };
    sheet.addEventListener('pointerdown', (event) => {
        scroll = sheet.querySelector('.tc-scroll');
        if (event.pointerType !== 'touch' || !event.isPrimary || topmostModal() !== modal) return reset();
        const offset = returning ? new window.DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42 : 0;
        reset();
        if (offset) sheet.style.transform = `translateY(${offset}px)`;
        drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: scroll.scrollTop,
            inScroll: scroll.contains(event.target),
            offset,
            distance: offset,
            moved: false
        };
    });
    sheet.addEventListener('pointermove', (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        const dy = event.clientY - drag.y;
        if (Math.abs(event.clientX - drag.x) > Math.abs(dy) && !drag.moved) return reset();
        if (Math.abs(dy) < 8 && !drag.moved) return;
        if (topmostModal() !== modal) return reset();
        drag.moved = true;
        sheet.setPointerCapture(event.pointerId);
        event.preventDefault();
        blockClickUntil = performance.now() + 500;
        if (drag.inScroll) scroll.scrollTop = Math.max(0, drag.start - dy);
        drag.distance = Math.max(0, drag.offset + dy - (drag.inScroll ? drag.start : 0));
        sheet.style.transform = `translateY(${drag.distance}px)`;
    });
    sheet.addEventListener('pointerup', (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        const dismiss = drag.distance >= sheet.clientHeight * 0.5;
        if (!drag.moved) return reset();
        drag = null;
        if (dismiss && topmostModal() === modal) {
            if (!dismissChatModals()) closeModalReturning(modal.id);
        } else settle();
    });
    sheet.addEventListener('pointercancel', settle);
    sheet.addEventListener(
        'click',
        (event) => {
            if (performance.now() < blockClickUntil) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        true
    );
    modal.addEventListener('close', () => !modal.open && reset());
}

const refitOpen = () => document.querySelectorAll('dialog[open] .title-sheet').forEach(fitTitleSheet);
window.addEventListener('resize', refitOpen);
window.visualViewport?.addEventListener('resize', refitOpen);
document.fonts?.ready.then(refitOpen);
