# Admin panel design system

Dark, dense and neutral, in the style of shadcn/ui's dashboard. The tokens live in `css/base.css`;
every other stylesheet uses them, so a raw colour, size or radius anywhere else is a bug.

## Colour

| Token                              | Value                         | Use                                                   |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `--bg`                             | `#0a0a0a`                     | Page and sidebar                                      |
| `--inset`                          | `#111111`                     | Main content panel                                    |
| `--surface-1`                      | `#171717`                     | Cards                                                 |
| `--surface-2`                      | `#1f1f1f`                     | Row hover, inputs, list items                         |
| `--surface-3`                      | `#262626`                     | Selected nav item, tab track, hover on buttons        |
| `--surface-overlay`                | `#171717`                     | Modals, toasts, dropdowns                             |
| `--border` / `--border-strong`     | `#262626` / `#333333`         | Card edges and row lines / control edges              |
| `--text` / `--text-dim`            | `#fafafa` / `#a3a3a3`         | Body / secondary text                                 |
| `--primary` / `--on-primary`       | `#fafafa` / `#171717`         | Primary button: inverted, white with dark text        |
| `--success` `--warning` `--danger` | `#4ade80` `#fbbf24` `#f87171` | Status text, with a matching `*-soft` fill for badges |

The palette is grey on purpose: colour appears only in status badges. Links are underlined
foreground text, not a brand colour.

**Contrast.** Every text token passes WCAG AA (4.5:1) on every surface. The lowest pairs are
`--danger` on `--surface-3` at 5.5:1 and white on `--danger-fill` at 4.8:1.

## Type

- **Geist** for the UI, **Geist Mono** for IDs and logs (`code`, `.mono`). Figures use tabular
  numbers.
- The scale is `--text-xs` 12, `--text-sm` 13, `--text-base` 14 (body), `--text-lg` 16,
  `--text-xl` 20 and `--text-2xl` 24 (page titles, bold, -0.02em).
- Inputs use at least 16px so iOS Safari does not zoom in on focus.

## Spacing and shape

- **Spacing:** a 4px grid, `--space-1` to `--space-8`. Cards are padded `--space-5` / `--space-6`
  (`--space-4` on phones), with `--space-4` gaps between them.
- **Radius:** `--radius-sm` 8px for controls, rows and badges; `--radius-lg` 12px for cards, the
  content panel and modals.
- **Control height:** `--control-h` sets the height of every button, input and nav item. It is
  36px with a mouse and 44px on touch screens (`pointer: coarse`). A compact button gets less
  padding but the same height, so a hit area never shrinks.

## Components

- **Stat card:** a muted title with an optional outlined badge in the corner, a 30px figure, and a
  two-line footer (a bold line with an icon, then a muted line). Show only real numbers. There is
  no history, so don't invent trend percentages.
- **Tabs:** a `--surface-3` track. The selected trigger is raised to the panel colour with a border.
- **Data table:** no row fills; rows are split by `--border` lines and tinted on hover.
- **Buttons:** primary is inverted, secondary is an outline on `--bg`, destructive is red.

## Interaction

- **Focus:** one focus ring for everything, `:focus-visible` with a 2px `--focus-ring` outline
  and a 2px offset.
- **Hover:** changes the background or border colour over 150ms. Nothing moves.
- **Navigation:** nav items are real `<button>`s grouped under labels (Overview, Data, System)
  inside `<nav>`. The current section carries `aria-current="page"`.
- **Icons:** inline SVG line icons (`.icon`, 18px; 16px in the nav). Don't use emoji as icons.
- **Reduced motion:** `prefers-reduced-motion` turns off all animation and transitions.

## Layout

- **Desktop:** a fixed 240px sidebar on `--bg`. The content sits on a rounded `--inset` panel
  with an 8px gap around it.
- **1024px and below:** the sidebar becomes an off-canvas drawer opened by a 44px button.
- **768px and below:** stats sit two per row, the header stacks and tabs span the full width.
- **760px and below:** table rows become labelled cards, built from each cell's `data-label`.
- **640px and below:** the panel runs edge to edge.
- **Width:** no breakpoint may cause horizontal page scroll.
