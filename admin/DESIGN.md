# Admin panel design system

Dark, warm and calm: a near-black page, cards one step lighter, hairline borders, no shadows.
The tokens live in `css/base.css`; every other stylesheet uses them, so a raw colour, size or
radius anywhere else is a bug.

## Colour

| Token                                     | Value                                 | Use                                                  |
| ----------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| `--bg`                                    | `#0e0d0c`                             | Page and icon rail (the content has no inset panel)  |
| `--surface-1`                             | `#161513`                             | Cards                                                |
| `--surface-2`                             | `#1f1e1b`                             | Hover, rows, inputs                                  |
| `--surface-3`                             | `#26241f`                             | Selected items, tooltips, secondary buttons          |
| `--border` / `--border-row` / `--border-strong` | white at 6% / 5% / 10%          | Card edges / lines between list rows / control edges |
| `--text` / `--text-secondary`             | `#f3f1ec` / `#c9c5bd`                 | Body / quieter labels (statuses, switch)             |
| `--text-dim` / `--text-faint`             | `#a29e96` / `#75716a`                 | Descriptions, meta / ranks, icons, "off" states      |
| `--accent` / `--on-accent`                | `#f5b14c` / `#1a1206`                 | The logo and a switch that is on. Nothing else       |
| `--primary` / `--on-primary`              | `#f3f1ec` / `#161513`                 | Primary button: inverted, light with dark text       |
| `--success` / `--danger` / `--danger-dot` | `#6fd394` / `#ff8a7f` / `#ff6b5e`     | Status text and dots; `*-soft` fills where needed    |

Colour means status. The accent is used sparingly; links and the active nav item use plain
foreground.

**Contrast.** `--text`, `--text-secondary` and `--text-dim` pass WCAG AA (4.5:1) on every
surface. `--text-faint` does not and is kept for decoration and disabled states only.

## Type

- **Onest** for the UI (it covers Cyrillic), **JetBrains Mono** for IDs and logs (`code`).
  Numbers and dates use tabular figures.
- Base 14px / 1.4. Page titles 36px, weight 600, -0.03em. Stat figures 44px, -0.035em. Card
  titles 17px / 600. Small text 13px, captions 12px.
- Inputs use at least 16px so iOS Safari does not zoom in on focus.

## Spacing and shape

- **Spacing:** a 4px grid, `--space-1` to `--space-8`. The page and every gap between blocks is
  12px; cards are padded 20–24px, list rows 12–15px.
- **Radius:** 8 tooltips and small buttons, 10 buttons, 12 rail items and the logo, 14 banners,
  20 cards (`--radius-lg`), 999 switches.
- **Control height:** `--control-h` sets the height of buttons, inputs and rows. It is 36px with a
  mouse and 44px on touch screens (`pointer: coarse`).

## Components

- **Icon rail:** 56px wide, sticky, on the page background. 44px items with 19px icons; the label
  is a tooltip on hover and keyboard focus. Actions and Danger Zone sit at the bottom. Below
  1024px the rail gives way to a bottom tab bar.
- **Service statuses:** a 7px dot and a short label ("TG", "KP: ERR", a hollow dot for "Proxy:
  OFF"). Each opens its dialog. Any error raises a banner above the stats.
- **Stat card:** label, 44px figure with an optional quiet secondary ("+6 archived"), then a title
  and a description. Show only real numbers; there is no history to make trends from.
- **Lists on cards:** rows split by `--border-row`, no fills; the title underlines on hover.
- **Tabs:** a `--surface-3` track. The selected trigger is raised to the panel colour.
- **Buttons:** primary is inverted, outline for secondary actions on cards, destructive is red.

## Interaction

- **Focus:** one focus ring for everything, `:focus-visible` with a 2px `--focus-ring` outline
  and a 2px offset.
- **Hover:** changes the background or colour over 150–200ms. Nothing moves.
- **Navigation:** rail items are real `<button>`s with `aria-label`, inside `<nav>`. The current
  section carries `aria-current="page"`.
