/** Layout and phone gestures shared by every title-card entry point. */
import { closeModalReturning, dismissChatModals, isPhoneTitleSheet, topmostModal } from './ui.js';

const layouts = new WeakMap();
const copies = new WeakMap();
const swipes = new WeakMap();
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
        state = { scroll, width: 0, viewport: 0, fixed: null, footer: null, observer: null, pending: false };
        modal.style.removeProperty('--title-top');
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
        setupSheetSwipe(sheet, scroll, modal);
    }
    const phone = isPhoneTitleSheet();
    const viewport = window.visualViewport?.height || window.innerHeight;
    if (Math.abs(sheet.clientWidth - state.width) > 1 || viewport !== state.viewport) {
        state.width = sheet.clientWidth;
        state.viewport = viewport;
        state.fixed = state.footer = null;
        modal.style.removeProperty('--title-top');
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
    const scrollStyle = getComputedStyle(scroll);
    const gap = pixels(scrollStyle.rowGap);
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
        pixels(scrollStyle.paddingTop) +
        pixels(scrollStyle.paddingBottom) +
        pixels(style.borderTopWidth) +
        pixels(style.borderBottomWidth);
    const room = phone
        ? Math.max(24, base - insets - state.footer - state.fixed)
        : description
          ? pixels(getComputedStyle(description.querySelector('.tc-overview')).lineHeight) * 3
          : 0;
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
        const used = expanded || !phone ? text.scrollHeight : room;
        description.style.height = `${used}px`;
    }
    sheet.style.height = phone ? `${base}px` : 'auto';
    if (!phone && !modal.style.getPropertyValue('--title-top')) {
        // Centre once; disclosure grows downwards without moving the reading position.
        modal.style.setProperty(
            '--title-top',
            `${Math.round(Math.max(pixels(modalStyle.paddingBottom), (modal.clientHeight - height(sheet)) / 2))}px`
        );
    }
    scroll.scrollTop = scrollTop;
}

/** Native content scrolling owns its whole gesture; only a downward pull from the top moves the sheet. */
export function setupSheetSwipe(sheet, scroll, modal, scrollSelector = '.tc-scroll') {
    if (swipes.get(modal)?.sheet === sheet) return;
    swipes.get(modal)?.reset();
    let drag = null;
    let returning = null;
    let blockClickUntil = 0;
    const reset = () => {
        returning?.cancel();
        returning = null;
        sheet.style.removeProperty('transform');
        sheet.classList.remove('tc-dragging');
        drag = null;
    };
    const settle = () => {
        drag = null;
        sheet.classList.remove('tc-dragging');
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
    const interrupt = () => {
        if (drag?.mode === 'drag') settle();
        else drag = null;
    };
    swipes.set(modal, { sheet, reset, interrupt });
    if (!modal.dataset.titleSwipeWatched) {
        modal.dataset.titleSwipeWatched = 'true';
        // A second finger can land on the exposed backdrop, outside the moving sheet.
        modal.addEventListener(
            'touchstart',
            (event) => {
                if (event.touches.length > 1) swipes.get(modal)?.interrupt();
            },
            { capture: true, passive: true }
        );
        // These modal listeners refer only to its current sheet, not every replaced card.
        modal.addEventListener('close', () => !modal.open && swipes.get(modal)?.reset());
    }
    sheet.addEventListener(
        'touchstart',
        (event) => {
            if (!isPhoneTitleSheet()) return;
            if (event.touches.length !== 1) {
                return interrupt();
            }
            if (topmostModal() !== modal || modal.inert) return;
            scroll = sheet.querySelector(scrollSelector);
            const offset = returning ? new window.DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42 : 0;
            reset();
            blockClickUntil = 0;
            if (offset) {
                sheet.style.transform = `translateY(${offset}px)`;
                sheet.classList.add('tc-dragging');
            }
            const touch = event.touches[0];
            drag = {
                id: touch.identifier,
                x: touch.clientX,
                y: touch.clientY,
                offset,
                distance: offset,
                height: sheet.clientHeight,
                mode: offset > 0 ? 'drag' : scroll.contains(event.target) && scroll.scrollTop > 1 ? 'native' : null
            };
        },
        { passive: true }
    );
    sheet.addEventListener(
        'touchmove',
        (event) => {
            if (!drag) return;
            if (event.touches.length !== 1) return interrupt();
            if (drag.mode === 'native') return;
            const touch = event.touches[0];
            if (touch.identifier !== drag.id) return;
            if (topmostModal() !== modal) return settle();
            const dx = touch.clientX - drag.x;
            const dy = touch.clientY - drag.y;
            if (drag.mode !== 'drag') {
                // Ignore small direction jitter before committing to either scrolling or dismissal.
                if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
                if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !event.cancelable) {
                    drag.mode = 'native';
                    return;
                }
                drag.mode = 'drag';
                sheet.classList.add('tc-dragging');
            }
            if (!event.cancelable) return settle();
            event.preventDefault();
            blockClickUntil = performance.now() + 500;
            drag.distance = Math.max(0, drag.offset + dy);
            // No layout reads or scrollTop writes on movement: content keeps the browser's scrolling/inertia.
            sheet.style.transform = `translate3d(0, ${drag.distance}px, 0)`;
        },
        { passive: false }
    );
    sheet.addEventListener('touchend', (event) => {
        if (!drag || ![...event.changedTouches].some((touch) => touch.identifier === drag.id)) return;
        if (event.touches.length) return interrupt();
        if (drag.mode !== 'drag') {
            drag = null;
            return;
        }
        const dismiss = drag.distance >= drag.height * 0.3;
        drag = null;
        sheet.classList.remove('tc-dragging');
        if (dismiss && topmostModal() === modal) {
            if (!dismissChatModals()) closeModalReturning(modal.id);
        } else settle();
    });
    sheet.addEventListener('touchcancel', interrupt);
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
}

const refitOpen = () => document.querySelectorAll('dialog[open] .title-sheet').forEach(fitTitleSheet);
window.addEventListener('resize', refitOpen);
window.visualViewport?.addEventListener('resize', refitOpen);
document.fonts?.ready.then(refitOpen);
