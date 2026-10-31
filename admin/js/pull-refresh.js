/**
 * Pull to refresh on touch screens: pulling the page down at its very top reloads what is on screen,
 * like the refresh button, without reloading the page. The page follows the finger with growing
 * resistance, a ring fills in the gap above it, and on release the page holds there while the ring
 * spins; a check shows the end. The browser's own pull (a full reload that lost the open tab) is
 * turned off in CSS (`overscroll-behavior-y: none`).
 */

import { $ } from './dom.js';
import { topmostModal } from './ui.js';
import { isDropdownOpen } from './select.js';

// How far the page moves (px) at which a release refreshes, where it waits meanwhile, and the
// furthest it goes however far the finger does
export const PULL_TRIGGER = 64;
const PULL_HOLD = 56;
const PULL_MAX = 120;
// The finger distance over which the resistance builds up
const PULL_STRETCH = 200;
// How long the check stays, and the slide back (layout.css `--pull-back`)
const DONE_MS = 500;
const BACK_MS = 350;

/** Rubber band: follows the finger at first, then ever more slowly towards PULL_MAX. */
export const stretch = (dy) => PULL_MAX * (1 - Math.exp(-Math.max(0, dy) / PULL_STRETCH));

/** True if the touch began inside something scrolled down: the pull scrolls that up instead. */
function insideScrolled(target) {
    for (let el = target; el && el !== document.body; el = el.parentElement) {
        if (el.scrollTop > 0) return true;
    }
    return false;
}

/** A short tick when the pull reaches the point of refreshing (Android; iOS has no web vibration). */
function tick() {
    try {
        navigator.vibrate?.(8);
    } catch {
        // Not allowed before the page was tapped: no tick then
    }
}

/** @param {() => Promise<unknown>} refresh reloads the visible section (app.js `refreshNow`) */
export function setupPullRefresh(refresh) {
    const el = $('pull-refresh');
    if (!el) return;
    const root = document.documentElement;

    let startX = 0;
    let startY = null;
    let pull = 0;
    let busy = false;
    let settle = 0;

    /** Moves the page and the ring; `state` is the one phase class on the indicator. */
    const show = (px, state) => {
        pull = px;
        root.style.setProperty('--pull', `${px}px`);
        root.style.setProperty('--pull-progress', String(Math.min(1, px / PULL_TRIGGER)));
        // The page is moved only while pulled: a transform on it always would make it the box
        // that fixed and sticky elements inside it are placed against
        clearTimeout(settle);
        if (px > 0) root.classList.add('pull-moving');
        else settle = window.setTimeout(() => root.classList.remove('pull-moving'), BACK_MS);
        for (const s of ['pulling', 'ready', 'refreshing', 'done']) el.classList.toggle(s, s === state);
        // How the page moves: with the finger, springing into the wait, or easing back
        root.classList.toggle('pull-dragging', state === 'pulling' || state === 'ready');
        root.classList.toggle('pull-holding', state === 'refreshing' || state === 'done');
    };

    document.addEventListener(
        'touchstart',
        (e) => {
            const blocked =
                busy ||
                e.touches.length !== 1 ||
                window.scrollY > 0 ||
                topmostModal() ||
                isDropdownOpen() ||
                document.body.classList.contains('signed-out') ||
                insideScrolled(e.target);
            startY = blocked ? null : e.touches[0].clientY;
            startX = blocked ? 0 : e.touches[0].clientX;
        },
        { passive: true }
    );

    document.addEventListener(
        'touchmove',
        (e) => {
            if (startY === null) return;
            const dy = e.touches[0].clientY - startY;
            const dx = e.touches[0].clientX - startX;
            // A sideways swipe or a scroll up is not a pull: let it go for this touch
            if (pull === 0 && (dy <= 0 || Math.abs(dx) > dy)) {
                if (dy < 0 || Math.abs(dx) > Math.abs(dy)) startY = null;
                return;
            }
            const px = stretch(dy);
            const ready = px >= PULL_TRIGGER;
            if (ready && !el.classList.contains('ready')) tick();
            show(px, ready ? 'ready' : 'pulling');
        },
        { passive: true }
    );

    document.addEventListener('touchend', () => {
        if (startY === null && pull === 0) return;
        startY = null;
        if (pull < PULL_TRIGGER) return show(0);
        busy = true;
        show(PULL_HOLD, 'refreshing');
        Promise.resolve()
            .then(refresh)
            .finally(() => {
                show(PULL_HOLD, 'done');
                window.setTimeout(() => {
                    show(0);
                    busy = false;
                }, DONE_MS);
            });
    });

    // The system took the touch (an edge swipe, a call): spring back without refreshing
    document.addEventListener('touchcancel', () => {
        if (busy) return;
        startY = null;
        show(0);
    });
}
