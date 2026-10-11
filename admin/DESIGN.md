# Admin panel design system

Dark, dense, flat. The tokens live in `css/base.css`; every other stylesheet uses them, so a raw
colour, size or radius anywhere else is a bug.

## Colour

| Token                              | Value                         | Use                                                   |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `--bg`                             | `#020617`                     | Page background                                       |
| `--surface-1`                      | `#0b1120`                     | Sidebar, cards                                        |
| `--surface-2`                      | `#111a2e`                     | Table rows, inputs, list items                        |
| `--surface-3`                      | `#18233d`                     | Hover                                                 |
| `--surface-overlay`                | `#0d1426`                     | Modals, toasts, dropdowns                             |
| `--border` / `--border-strong`     | `#1e293b` / `#334155`         | Card edges / control edges                            |
| `--text` / `--text-dim`            | `#f8fafc` / `#94a3b8`         | Body / secondary text                                 |
| `--primary`                        | `#4f46e5`                     | Fills only: primary button, rank dot                  |
| `--primary-text`                   | `#a5b4fc`                     | Brand colour as text: links, logo, active tab         |
| `--success` `--warning` `--danger` | `#4ade80` `#fbbf24` `#f87171` | Status text, with a matching `*-soft` fill for badges |

Depth comes from lightness steps between surfaces, not from blur or shadows.

**Contrast.** Every text token passes WCAG AA (4.5:1) on every surface. The lowest pairs are
`--text-dim` on hover at 6.1:1 and white on `--danger-fill` at 4.8:1. Never put `--primary` on a
dark surface as text, because it only reaches 4:1. Use `--primary-text` instead.

## Type

- **Fira Sans** for the UI. **Fira Code** with tabular numbers for figures, IDs and logs (`code`,
  `.mono`, `.stat-value`).
- The scale is `--text-xs` 12, `--text-sm` 13, `--text-base` 14 (body), `--text-lg` 16,
  `--text-xl` 20 and `--text-2xl` 24 (page titles).
- Inputs use at least 16px so iOS Safari does not zoom in on focus.
- Table headers and stat titles are xs, uppercase, with 0.05em letter-spacing.

## Spacing and shape

- **Spacing:** a 4px grid, `--space-1` to `--space-8`. Card padding is `--space-5`
  (`--space-4` on phones). Gaps between cards are `--space-3`. Table cells are
  `--space-2` / `--space-3`.
- **Radius:** `--radius-sm` 6px for controls, rows and badges; `--radius` 10px for stat cards;
  `--radius-lg` 14px for content cards and modals.
- **Control height:** `--control-h` sets the height of every button, input and nav item. It is
  36px with a mouse and 44px on touch screens (`pointer: coarse`). A compact button gets less
  padding but the same height, so a hit area never shrinks.

## Interaction

- **Focus:** one focus ring for everything, `:focus-visible` with a 2px `--focus-ring` outline
  and a 2px offset.
- **Hover:** changes the background or border colour over 150ms. Nothing moves.
- **Navigation:** nav items are real `<button>`s inside `<nav><ul>`. The current section carries
  `aria-current="page"`.
- **Icons:** inline SVG line icons (`.icon`, 18px, `currentColor`). Don't use emoji as icons.
- **Reduced motion:** `prefers-reduced-motion` turns off all animation and transitions.

## Layout

- **Desktop:** fixed 232px sidebar.
- **1024px and below:** the sidebar becomes an off-canvas drawer opened by a 44px button.
- **760px and below:** table rows become labelled cards, built from each cell's `data-label`.
- **768px and below:** stats sit two per row and the header stacks.
- **Width:** no breakpoint may cause horizontal page scroll.
