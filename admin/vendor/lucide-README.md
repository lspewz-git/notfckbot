# Lucide icons

Selected unmodified SVG paths from lucide-static 0.468.0 (ISC).
Source: https://www.npmjs.com/package/lucide-static/v/0.468.0
Upstream: https://github.com/lucide-icons/lucide

Only the symbols used by the panel are included, as `<symbol id="i-<name>">` in the hidden
`.icon-sprite` at the top of `admin/index.html`; icons point at them with `<use href="#i-<name>">`.
They live in the page, not in a separate sprite file: WebKit (Telegram on iOS) asked the server for
an external sprite again whenever new icons appeared, so sheets drew their icons late (14.11).
There are no external requests, fonts, runtime packages or build steps.
Keep the adjacent license when updating the icons.
Use a 24 × 24 viewBox, currentColor, fill none and stroke width 2 (the shared .icon class).
Brand logos and the animated pull-to-refresh indicator are separate assets.
