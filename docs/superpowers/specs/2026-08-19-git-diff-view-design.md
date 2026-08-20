# Git diff view — design

Side-by-side and inline, read-only, the active file against its git base.
The second row of v0.5: the line diff exists, the review panel exists —
this is git wiring plus a second layout.

Status: decided 2026-08-19. Everything named here was read in the file it
names (or mapped by an agent and re-checked) before being written down.

## 1. What it is

**Show Changes** (`git.showDiff`, category Git) fills the editor area —
the slot ReviewPanel and AgentPanel already share — with the active file's
diff against the index: the same base the gutter uses, from the same
cache. Two layouts, toggled in the view's header and persisted as
`workbench.diffLayout` (`side-by-side` default, `inline` for narrow
windows and long lines). Clicking a git-gutter mark opens it too — the
click the gutter's design deferred to exactly this feature.

Read-only on purpose. Editing belongs in the editor; reverting a hunk
belongs to stage/commit (it is `git checkout -p`'s sibling and wants the
same confirmation shape). A view that only shows is a view that cannot
destroy.

## 2. The surface

- `ui.diffOpen`, a third editor-area surface beside `reviewOpen` and
  `agentsOpen`, **layered below both**: `showDiff()` clears the other
  two, `showAgents()` clears `diffOpen`, but staging a review over an
  open diff leaves `diffOpen` set — the render conditional shows the
  review, and Escape uncovers the diff again rather than the editor.
  `hasDismissible` and `dismissTop` gain the branch (after review and
  agents — the order in that function is the z-order).
- **Deliberate deviation:** `app.ts` closes review and agents when
  `workspace.activeId` changes ("going to a file must show the file").
  The diff view *follows* the active buffer instead — it is a lens on
  whichever file is current, and switching tabs while it is open shows
  the new file's changes. A file with no changes says so in an empty
  state rather than closing the view under the user.
- Escape closes; a Close button closes; there is no status-bar re-entry
  pill (the review's pill announces *pending decisions*; a diff has
  none).

## 3. The data

- `GitService.baseFor(path): string | null | undefined` — the private
  `#bases` cache made readable: `undefined` not fetched yet, `null` git
  has nothing, string the normalized index text. The view never fetches;
  the service's existing triggers (open, save, activation, refresh) own
  freshness, and the view inherits the gutter's staleness story —
  including its `.git` blind spot, already documented there.
- The view subscribes `git.hunks` + `workspace.activeId` + the buffer's
  revision (via `workspace.buffers`), and derives rows from
  `baseFor(path)` + `textOf(id)` + the hunks already computed. Nothing
  is diffed twice; over 2 MB the service already refused, and the view
  shows the same absence.

## 4. The rows — `src/core/diff-view.ts`, pure

```ts
export interface SideCell { line: number; text: string }   // 1-based in its own side; text without terminator
export type DiffViewRow =
  | { kind: 'context'; before: SideCell; after: SideCell }
  | { kind: 'change'; before: SideCell | null; after: SideCell | null }
  | { kind: 'fold'; count: number };
export function diffViewRows(
  base: string, current: string, hunks: readonly Hunk[], context?: number, // default 3
): DiffViewRow[]
```

- Change rows are **paired**: within a hunk, `removed[i]` beside
  `added[i]`; the longer side's tail gets `null` opposite — the shape
  every split view uses, and the inline layout regroups it (below).
- `context` unchanged lines are shown either side of a hunk; longer
  stretches — including the file's head and tail — collapse to one
  `fold` row carrying the hidden count. Two hunks whose context would
  overlap merge their context; a gap of zero folds nothing.
- Invariant the inline layout leans on, asserted in tests: **two change
  rows from different hunks are always separated by at least one
  context or fold row** (hunks are separated by ≥1 equal line, and
  context ≥ 1 shows it; context 0 is not offered).
- `line` numbers are real file line numbers on each side, derived from
  `fromLine` and the running offset; `splitLines`' terminator-carrying
  invariant makes index = line − 1 on both sides.

The inline layout derives from the same rows in the component: a
contiguous run of change rows is one hunk (the invariant), rendered as
all its befores (−) then all its afters (+); context and fold rows pass
through. One model, two renderings, no second differ.

## 5. The component — `src/ui/DiffView.svelte`

ReviewPanel's visual language, read-only:

- Header: file name + folder (the `.file-head` shape), "N changes",
  the layout toggle (two small ghost buttons, writing
  `config.set('workbench.diffLayout', …)` so the setting and the toggle
  cannot disagree), Close.
- Side-by-side: a two-column grid, each cell a line-number gutter +
  `white-space: pre` text; before-side changes tinted with the review's
  own convention (`color-mix(in srgb, var(--nox-danger) 12%,
  transparent)`), after-side with `--nox-success` at 12%; a `null` cell
  renders as an empty tinted spacer, so pairing stays visually aligned.
- Inline: one column, `−`/`+` signs (U+2212, as the review panel spells
  it), both line-number gutters side by side (before/after).
- Fold rows: one full-width quiet row, "⋯ N unchanged lines"; clicking
  any fold expands the whole file (context → ∞) for this view instance —
  per-fold expansion is bookkeeping the first version does not need, and
  the click target already behaves usefully.
- Empty states, each honest: no active file; file not in a repository
  (or untracked, or git absent — the service cannot tell them apart and
  the view does not pretend to); no changes; file too large to diff.
- No virtualization: the rows are bounded by fold collapsing, and the
  review panel already renders whole staged sets un-virtualized.

## 6. Openings

- `git.showDiff` — **Show Changes**, category **Git** (new; and
  `git.refreshGutter` moves from Editor to Git so the palette groups
  them). Enabled on `git.started` and an active buffer with a path — the
  service, not the platform flag, because the service only starts where
  the capability holds and tests start it over a memory platform: the
  language-server pattern, and the first draft's capability gate is what
  the jsdom suite refused to run.
- Clicking a git-gutter mark: an `onGitGutterClick` **facet** the pane
  fills with “run `git.showDiff`”, read by the gutter's own
  `domEventHandlers.mousedown`. A facet because the extension is built
  from settings alone and must stay app-free — and because the first
  draft's pane-level `EditorView.domEventHandlers` never fired: those
  listen on the content element, and gutters are its siblings, which the
  jsdom suite proved before a human had to.

## 7. What is tested, and how

- `tests/diff-view.test.ts` (node): rows built from real `diffText`
  output — pairing (equal, longer-removed, longer-added), line numbers
  on both sides across multiple hunks, context merging between near
  hunks, head/tail folds, the fold count, context default, the
  change-rows-separated invariant, empty diff → single fold, whole-file
  change → no context rows.
- `tests/git-diff-view.test.ts` (jsdom): real app + `DiffView` +
  MemoryPlatform seeds. Cases: command opens the view and review/agents
  surfaces close; rows render with the right tints and numbers in both
  layouts; the toggle writes the setting; switching the active buffer
  re-renders to the new file (the deviation, proven); the no-changes
  and no-repo empty states; Escape closes (dismissTop); gutter
  mousedown on a mark opens the view.
- Mutation-checked before shipping, recorded in the docblocks.

## 8. Not in this

- Revert/stage hunk (stage/commit row).
- Diffing two arbitrary files or revisions — this is *the file against
  its base*; a general diff tool is a different feature with a picker.
- Syntax highlighting inside the diff. Plain mono text, like the review
  panel; highlighting both sides means two more editor states per view
  and buys little for a read-only glance.
- Word-level (intra-line) diffs. Line granularity, like everything else
  built on `diff.ts`.
