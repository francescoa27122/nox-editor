# Explorer virtualisation — design

Render the rows you can see. The last row of the v0.2 *Trust* table and the
last pure-code 1.0 gate — the bar's own words: *"the only trust-row item whose
absence a larger project would feel every day."*

Status: decided 2026-08-20. Every path, function and number below was read in
the file it names before being written down.

## 0. The envelope

- **The model does not change.** `FileTreeService` has exposed the tree as a
  flat ordered list since v0.1, and its header says why: *"flat is what the
  renderer wants … and leaves the door open for windowing when someone opens
  a folder with 50,000 entries."* This is that door. `#flatten`, `FlatNode`
  and every service test are untouched.
- **Rows are a fixed height, and there is exactly one place that says so.**
  Windowing by index requires it. Today `.row { height: 23px }` lives in CSS;
  it moves to a TS constant that the CSS reads through a custom property, so
  the number the arithmetic uses and the number the browser paints cannot
  drift apart.
- **What cannot be measured is not windowed.** With a viewport height of
  zero — before layout, and under jsdom, which has none — the panel renders
  every row. Windowing on an unmeasured viewport would silently render
  nothing, which is a much worse failure than rendering too much.
- **A screen reader must not be told the tree is 40 rows long.** Windowing
  removes rows from the DOM, so `aria-setsize` and `aria-posinset` become
  mandatory rather than optional. Adding them is part of this change, not a
  follow-up.

## 1. The window

```ts
const ROW_HEIGHT = 23;   // and `--nox-tree-row-h`, set from here
const OVERSCAN = 8;      // rows rendered beyond each edge
const MIN_ROWS_TO_WINDOW = 200;
```

State: `scrollTop` and `viewportHeight`, both `$state`, both written from the
container — `onscroll` for the first, and a `ResizeObserver` (where the
environment has one) plus a read of `clientHeight` for the second.

```
windowed   = viewportHeight > 0 && nodes.length > MIN_ROWS_TO_WINDOW
firstIndex = windowed ? max(0, floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0
visibleEnd = windowed ? min(n, firstIndex + ceil(viewportHeight / ROW_HEIGHT) + 2 * OVERSCAN) : n
```

The rendered slice sits between two `role="presentation"` spacers of
`firstIndex * ROW_HEIGHT` and `(n - visibleEnd) * ROW_HEIGHT`, so the
scrollbar describes the whole tree and every row keeps its true offset.
Spacers rather than a transform: the container is also the drop target and the
keyboard surface, and a transformed child changes what `contains()` and
`getBoundingClientRect()` mean for both.

**`MIN_ROWS_TO_WINDOW` is not a performance tuning knob**; it is the point
below which the extra state is a liability rather than a saving. A 40-row
folder renders exactly as it does today, which is also what keeps every
existing behaviour test honest.

## 2. Scrolling to the lead row

`scrollSelectionIntoView()` currently does
`listElement.querySelector('.row.lead')?.scrollIntoView()`. That stops working
the moment the lead row is outside the window — which is precisely when
scrolling to it matters. It becomes arithmetic on the index instead:

```
top = leadIndex * ROW_HEIGHT
if (top < scrollTop)                     scrollTop = top
else if (top + ROW_HEIGHT > scrollTop + h) scrollTop = top + ROW_HEIGHT - h
```

Strictly better than what it replaces: it does not require the row to exist,
and it needs no `scrollIntoView` — which jsdom does not implement, and which
the old code guarded with `?.` for exactly that reason.

The state is written back from the element in the same breath
(`scrollTop = el.scrollTop`), so the next window is computed without waiting
for a scroll event the environment may never send.

`openMenuFromKeyboard` (Shift+F10) still measures a real row, because a menu
needs real coordinates. It scrolls the lead into view, `await tick()`, then
measures — and keeps its existing fixed fallback if the row is still absent.

## 3. What is tested, and how

`tests/explorer-virtualisation.test.ts`, jsdom over `mountComponent`:

- a small tree renders every row — the no-window path, and the reason the
  rest of the suite is unaffected
- with a measured viewport and 600 rows, only a window is in the DOM, and it
  is far smaller than the tree
- the spacers' heights place the window at the right offset, and the three
  heights sum to `n * ROW_HEIGHT`
- scrolling renders a different window, and the rows in it are the rows at
  that offset
- `aria-setsize` is the whole tree on every rendered row, and `aria-posinset`
  is the row's true position, not its position in the window
- arrowing down past the window's edge scrolls, and the lead row is rendered
  afterwards
- an unmeasured viewport (height 0) renders everything rather than nothing

Measuring is stubbed the way jsdom requires: `clientHeight` defined on the
container, then a `scroll` event dispatched. That is the same door the real
listeners use.

## 4. Not in this

- **Variable row heights.** Nothing in the explorer has one.
- **Windowing anything else.** Search results, Problems and References have
  their own row models and their own natural limits; this change does not
  reach into them.

  **Superseded for search on 2026-08-21.** `SearchPanel` now uses this exact
  mechanism — same `MIN_ROWS_TO_WINDOW`, same `viewportHeight > 0` guard, same
  index-arithmetic reveal. It is the second instance of the shared-constant
  rule, and it publishes its own `--nox-search-row-h` rather than reusing
  `--nox-tree-row-h`: the two lists are 22px and 23px, so one shared name
  would inherit the wrong height into one of them. Problems and References
  remain unwindowed, and that should be re-decided on their own merits rather
  than inherited from this line.
- **Loading rows on scroll.** Directories already load lazily on expand; the
  flat list is fully in memory by construction.
