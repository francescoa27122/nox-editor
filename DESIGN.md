# Nox — Design System

The source of truth is [`src/styles/tokens.css`](src/styles/tokens.css). This
document explains the reasoning so the next person extends it rather than
working around it.

**The rule:** components never hardcode a colour, radius, duration or font. If
you need a value that does not exist, add a token.

---

## 1. Identity

Nox is Latin for *night*. The visual language draws on **eclipse and
moonlight** — cold, quiet, high-contrast where it matters and near-invisible
everywhere else. It is emphatically not a gaming UI: no glows on chrome, no
saturated gradients, no neon outlines.

The mark is a **crescent formed by subtracting an offset disc from a disc** —
one geometric operation, one path, legible at 16 px. It appears exactly three
times in the app (title bar, welcome screen, and the empty-pane placeholder —
the third arrived with split panes and this line was late to notice), and it
is the only element allowed
to carry a bloom.

---

## 2. Colour

### Surfaces

Nox is blue-black rather than the neutral grey most editors use. Five surface
levels, each a step of *elevation*, not a step of lightness for its own sake:

| Token | Eclipse | Used for |
|---|---|---|
| `--nox-bg-void` | `#06070A` | Behind everything, window edge |
| `--nox-bg-base` | `#0A0C11` | Title bar, status bar |
| `--nox-bg-panel` | `#0D1016` | Sidebar, tab strip |
| `--nox-bg-editor` | `#0B0E14` | The writing surface |
| `--nox-bg-raised` | `#12161F` | Palette, dialogs, inputs |

The editor is *lighter* than the panel beside it. That is deliberate: the text
you are working on should be the brightest plane in the window.

### Accents

One accent, used consistently, beats five used decoratively.

- **`--nox-accent` `#7DD3E0`** — glacial cyan. Everything interactive, focused
  or current. Moonlight on water.
- **`--nox-violet` `#8B7DF5`** — twilight. Reserved for *selection* and the
  active-tab spine. Seeing violet always means "this is selected."

Semantic colours (`success`, `warning`, `danger`, `info`) appear only in status
and notification contexts, never as decoration.

### Borders

`--nox-border` is `#171C26` — roughly 6% contrast against its neighbours. This
is intentional. Nox separates regions with **elevation and spacing**; borders
exist to stop two surfaces bleeding together, not to draw boxes. If a layout
needs a visible line to be legible, the spacing is wrong.

---

## 3. Syntax

The palette follows one rule so it stays coherent as languages are added:

| Category | Colour | Rationale |
|---|---|---|
| Keywords, control flow | Violet | **Structure** — the skeleton of the code |
| Strings | Green | **Literal data** |
| Numbers, constants, booleans | Orange | **Literal data**, warmer for scalars |
| Functions | Cyan | **Identity** — the things you name and call |
| Types, classes | Yellow | **Identity**, distinguished from behaviour |
| Variables | Default text | The baseline; most of the file |
| Properties | Soft blue | Identity, one step back from functions |
| Operators, punctuation | Muted | **Inert** — recedes toward the background |
| Comments | Muted, italic | **Inert** — present, never competing |

Structure is violet, data is warm, identity is cool, everything inert recedes.

### How far "recedes" goes

Not below 4.5:1. Syntax is the text a person spends the day reading, so WCAG
1.4.3 applies to it exactly as it applies to the chrome, and "editors have
always dimmed comments" is not a reason one has to be unreadable. Comments were
`#4c5768` — **2.64:1** on the writing surface — until 2026-08-22.

Comments now sit at 4.60:1 and are still the quietest thing in the buffer;
*italic*, not dimness, is what separates them from code. Operators and
punctuation are one token rather than two, which is what this table always
said they were — the second value was undocumented drift, and at 3.95:1 it was
also under the floor. `tests/token-contrast.test.ts` holds every
`--nox-syn-*` above 4.5:1 and holds that ordering.

The inert band is narrow now: 4.60 for comments, 5.24 for operators, 5.84 for
keywords. That compression is the cost of the floor and it is the right trade,
but it means a new syntax colour has less room than it looks — reach for hue to
separate a new category, not for lightness.

**Where the floor still does not hold.** A translucent highlight changes the
ground under the text it covers, and the dimmest tokens have no headroom left.
On a non-active search match a comment measures 3.01:1, and inside a selection
3.21:1. The **active** match was the indefensible one — 1.63:1, on the single
piece of text the user is definitely looking at — so it takes an explicit
`--nox-text-bright` foreground and measures 5.91:1, losing its syntax hue in
exchange. The other two keep their colour: they mark where something *is*
rather than asking to be read, and forcing a foreground across every selection
is a larger decision than this pass was making.

---

## 4. Typography

| | |
|---|---|
| **UI** | `-apple-system` → `SF Pro Text` → `Inter` → `Segoe UI` → `system-ui` |
| **Code** | `JetBrains Mono` → `SF Mono` → `Menlo` → `ui-monospace` |

Chrome text sits at **11–13 px** with `-0.01em` tracking; small system fonts
read better slightly tightened. Section headers are 10 px uppercase with
`0.06em` tracking — the spacing does the work that weight would otherwise do.

The editor sets `letter-spacing: 0.01em`, marginally looser than default.
Monospace at 13 px is measurably easier to scan with a hair of air between
glyphs.

Numeric readouts (line/column, match counts, sizes) use
`font-variant-numeric: tabular-nums` so they never jitter as digits change.

---

## 5. Space and shape

A 2 px-based scale: `2 · 4 · 6 · 8 · 12 · 16 · 24 · 32 · 48`.

Radii: `3` (chips, small controls) · `5` (inputs, buttons) · `8` (cards) ·
`12` (modals) · `999` (pills).

Fixed metrics live as tokens too — `--nox-titlebar-h: 36px`,
`--nox-tabbar-h: 35px`, `--nox-statusbar-h: 24px` — so vertical rhythm stays
consistent and a change lands everywhere at once.

---

## 6. Motion

**Budget: nothing over 190 ms, nothing on the typing path.**

| Token | Duration | Used for |
|---|---|---|
| `--nox-dur-fast` | 90 ms | Hover, colour shifts |
| `--nox-dur-base` | 130 ms | Panels appearing, toggles |
| `--nox-dur-slow` | 190 ms | Modal entrance, toasts |

Easing is a single curve, `cubic-bezier(0.22, 0.61, 0.36, 1)` — a decisive
ease-out. Only `opacity` and `transform` are animated, so nothing triggers
layout. `prefers-reduced-motion` sets every duration to `0ms`.

Nothing animates in response to typing, scrolling or cursor movement. An editor
that flourishes while you work is an editor you fight.

---

## 7. States

| State | Treatment |
|---|---|
| Hover | `--nox-hover` — a 15% cyan wash |
| Active / current | `--nox-active` — a 22% cyan wash, plus an accent-coloured icon |
| Selected (list) | `--nox-selected` — a 26% violet wash |
| Focus (keyboard) | `--nox-focus-ring`: 1 px background gap + 3 px accent glow, on `:focus-visible` only |
| Disabled | 42% opacity, no colour change |

These four are the only answer the app gives to *what is the pointer on* and
*what did I choose*, so §2's licence for near-invisible borders does not reach
them. Each is held to **1.25:1 against the darkest ground it lands on** —
Umbra's pure-black editor — by `tests/token-contrast.test.ts`, which
composites the wash before measuring it. Hover shipped at 5.5% until
2026-08-23, which is 1.06:1: fourteen rules across five panels used it as
their *only* hover feedback, and none of those surfaces visibly answered the
mouse.

The order matters as much as the floor. Over `--nox-bg-panel` the ladder is
hover 1.34 < selected 1.44 < active 1.62 < selected-strong 1.89. Hover is the
one state nobody asked for — it follows the pointer across everything it
crosses — so it must never out-shout a state that records a choice.

Two "you are here" markers carry most of the navigational weight:

- **Tab spine** — a 2 px violet→cyan gradient across the top of the active tab.
- **Explorer rail** — a 2 px accent bar on the left of the row for the open file.

---

## 8. Iconography

One set, hand-drawn on a 16 × 16 grid with a 1.4 px stroke, round caps and
joins. Geometric, never "friendly". Icons are `currentColor` throughout so they
inherit state colouring for free. Only `dot` and `folder` are filled — at 16 px
those two read better solid.

---

## 9. Adding a theme

A theme is a token override, not a fork. `Umbra` is the worked example and is
about twelve declarations:

```css
[data-nox-theme='umbra'] {
  --nox-bg-void: #000000;
  --nox-bg-editor: #000000;
  --nox-bg-raised: #0c0e12;
  --nox-text-bright: #ffffff;
  /* …only what differs; everything else cascades */
}
```

Add the theme name to the `workbench.theme` enum in `config/schema.ts` and it
appears in Settings. The editor picks it up with no CodeMirror reconfiguration
because the CM theme references the same CSS custom properties the chrome does
— the editor surface and the app chrome physically cannot drift apart.
