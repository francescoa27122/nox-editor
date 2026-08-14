# Change Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transaction log's recorded authors visible in the editor — a quiet gutter mark on lines a change set touched, a tooltip saying who and why, and commands to walk between them.

**Architecture:** A `StateField<RangeSet<ProvenanceValue>>` in each buffer's `EditorState`, fed by widening `changeSetAnnotation` to carry a full `Provenance` record. CodeMirror maps the ranges through subsequent edits for free; a user edit subtracts its own changed ranges so marks decay as you work. A gutter and a hover tooltip render the field; three commands act on it.

**Tech Stack:** TypeScript, CodeMirror 6 (`StateField`, `RangeSet`, `gutter`, `GutterMarker`, `hoverTooltip`), Svelte 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-provenance-design.md` — read it before Task 1.

## Global Constraints

- Branch: `provenance`. It exists and holds the spec commit.
- **Logic in services and the editor layer; components only render.**
- **Every user action is a command** registered in `src/app.ts`, so it reaches the palette (`Mod+Shift+P`) whether or not it has a chord.
- **Settings live in `src/services/config/schema.ts`.** This feature adds exactly one: `workbench.showChangeMarks`, boolean, default `true`, category `Workbench`.
- Every colour, radius and duration comes from `src/styles/tokens.css`. Dark themes only. The mark uses `--nox-violet-dim` — one colour for every author kind, no new tokens.
- Comments explain **why**, not what. Match the density of the file you are in.
- Every test carries a comment naming the regression it prevents. House style: `tests/terminal.test.ts`.
- Files are UTF-8.
- Verify commands: `npm test` (561 passing today), `npm run check`, `cargo test --manifest-path src-tauri/Cargo.toml` (35 passing; unaffected by this work but must stay green).
- Commit after every task. Do not push.

## The one thing most likely to be got wrong

**The state field must never go in a `Compartment`.** Reconfiguring a compartment to nothing *removes* its extensions, and removing a `StateField` destroys its state. Only the gutter and the tooltip are compartment-gated by the setting; the field is installed unconditionally and always records. Task 5 covers this and has a named test, because it is the one boundary error here that loses data silently rather than looking wrong.

## File structure

| File | Responsibility |
|---|---|
| `src/services/transactions.ts` | *modify* — the `Provenance` type; `changeSetAnnotation` widens to carry it |
| `src/services/workspace.ts` | *modify* — `apply()` annotates with the full record |
| `src/editor/provenance.ts` | *create* — the field, its update rule, the gutter, the tooltip, navigation helpers |
| `src/editor/extensions.ts` | *modify* — compose the field statically and the rendering in a compartment |
| `src/editor/theme.ts` | *modify* — the gutter's styling |
| `src/services/config/schema.ts` | *modify* — one setting |
| `src/app.ts` | *modify* — three commands |
| `tests/provenance.test.ts` | *create* — the field's behaviour, no DOM |

---

### Task 1: Provenance reaches the editor state

The plumbing: a type, a widened annotation, and a field that records marks. No clearing yet — Task 2 owns the update rule.

**Files:**
- Modify: `src/services/transactions.ts` (near `Author`, and `changeSetAnnotation` at :93)
- Modify: `src/services/workspace.ts` (the import at :18, and `apply()` around :1008-1022)
- Create: `src/editor/provenance.ts`
- Create: `tests/provenance.test.ts`

**Interfaces:**
- Consumes: `Author`, `authorLabel`, `ChangeSetId` from `@services/transactions`
- Produces:
  - `export interface Provenance { changeSetId: ChangeSetId; authorKind: Author['kind']; authorLabel: string; description: string; at: number }`
  - `changeSetAnnotation: Annotation<Provenance>` (was `Annotation<ChangeSetId>`)
  - `export class ProvenanceValue extends RangeValue { readonly provenance: Provenance }`
  - `export const provenanceField: StateField<RangeSet<ProvenanceValue>>`
  - `export function provenanceAt(state: EditorState, pos: number): Provenance | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/provenance.test.ts`:

```ts
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { provenanceField, type ProvenanceValue } from '../src/editor/provenance';
import { changeSetAnnotation, type Provenance } from '../src/services/transactions';

/**
 * The provenance field against hand-built transactions.
 *
 * No DOM and no workspace: the field is pure state, and driving it directly
 * is the only way to test the interleavings that matter — a mark mapped
 * through an unrelated edit, a mark half-deleted, a second change set landing
 * on top of a first.
 */

function record(overrides: Partial<Provenance> = {}): Provenance {
  return {
    changeSetId: 'cs-1',
    authorKind: 'agent',
    authorLabel: 'claude-1',
    description: 'Rewrite the greeting',
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [provenanceField] });
}

/** Every marked range, as [from, to, changeSetId] triples in document order. */
function marks(state: EditorState): [number, number, string][] {
  const out: [number, number, string][] = [];
  const cursor = state.field(provenanceField).iter();
  while (cursor.value) {
    out.push([cursor.from, cursor.to, (cursor.value as ProvenanceValue).provenance.changeSetId]);
    cursor.next();
  }
  return out;
}

/** Apply a change set the way `WorkspaceService.apply` does. */
function applySet(state: EditorState, changes: { from: number; to?: number; insert?: string }, provenance = record()): EditorState {
  return state.update({ changes, annotations: changeSetAnnotation.of(provenance) }).state;
}

describe('recording', () => {
  it('marks the inserted range of a change set', () => {
    const state = applySet(stateWith('hello world'), { from: 0, to: 5, insert: 'goodbye' });

    // The failure this prevents: marking the whole line, so a gutter bar
    // claims a line changed when seven characters did.
    expect(marks(state)).toEqual([[0, 7, 'cs-1']]);
  });

  it('carries the author through to the mark', () => {
    const state = applySet(stateWith('x'), { from: 1, insert: 'y' });

    const cursor = state.field(provenanceField).iter();
    expect((cursor.value as ProvenanceValue).provenance.authorLabel).toBe('claude-1');
    expect((cursor.value as ProvenanceValue).provenance.description).toBe('Rewrite the greeting');
  });

  /**
   * The failure this prevents: a zero-width mark at the deletion point, which
   * renders as a gutter bar on a line whose text nobody authored.
   */
  it('adds no mark for a change set that only deletes', () => {
    const state = applySet(stateWith('hello world'), { from: 5, to: 11 });

    expect(marks(state)).toEqual([]);
  });

  it('leaves an untouched document unmarked', () => {
    expect(marks(stateWith('hello'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/editor/provenance"`.

- [ ] **Step 3: Add the type and widen the annotation**

In `src/services/transactions.ts`, after `authorLabel`:

```ts
/**
 * What a marked range knows about itself.
 *
 * Denormalised on purpose: whatever renders this never looks anything up. The
 * log below is bounded, so a change set can rotate out of it while its marks
 * are still on screen — a tooltip that went blank when that happened would be
 * its own small lie.
 */
export interface Provenance {
  changeSetId: ChangeSetId;
  authorKind: Author['kind'];
  /** `authorLabel(author)`, resolved once at record time. */
  authorLabel: string;
  description: string;
  at: number;
}
```

Then widen the annotation, replacing the existing definition at :93:

```ts
/**
 * Marks a transaction as belonging to a change set, and says who made it.
 *
 * Carries the whole record rather than the id alone: the attribution field in
 * `editor/provenance.ts` needs the author, and a bare id would force it to
 * reach back into the log — which is bounded, so the answer would eventually
 * be "no idea".
 */
export const changeSetAnnotation = Annotation.define<Provenance>();
```

- [ ] **Step 4: Annotate with the full record**

In `src/services/workspace.ts`, extend the import at :18 to include `authorLabel` and `type Provenance`.

In `apply()`, immediately after `const id: ChangeSetId = ...` (around :1008):

```ts
    // One timestamp for the annotation and the log entry, so a mark and the
    // log never disagree about when something happened.
    const at = Date.now();
    const provenance: Provenance = {
      changeSetId: id,
      authorKind: spec.author.kind,
      authorLabel: authorLabel(spec.author),
      description: spec.description,
      at,
    };
```

Change the annotation line (around :1020) from `changeSetAnnotation.of(id)` to:

```ts
        annotations: [changeSetAnnotation.of(provenance), isolateHistory.of('full')],
```

And in the `this.log.record({...})` call below, replace `at: Date.now()` with `at`.

- [ ] **Step 5: Write the field**

Create `src/editor/provenance.ts`:

```ts
import {
  RangeSet,
  RangeValue,
  StateField,
  type EditorState,
  type Range,
  type Transaction,
} from '@codemirror/state';
import { changeSetAnnotation, type Provenance } from '@services/transactions';

/**
 * Who changed what, in this session, as ranges in the document.
 *
 * A `StateField` rather than a `ViewPlugin` — the distinction matters. Search
 * highlighting is a `ViewPlugin` because matches are *derivable*: given the
 * query and the document you can always recompute them. Provenance is not.
 * Once a change set is applied nothing in the document remembers who did it,
 * so it has to be recorded as it happens and carried forward. A `RangeSet` in
 * state gets the carrying-forward for free, and it accumulates in background
 * buffers too, because the workspace updates their state whether or not a view
 * exists.
 */

export class ProvenanceValue extends RangeValue {
  constructor(readonly provenance: Provenance) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return (
      other instanceof ProvenanceValue &&
      other.provenance.changeSetId === this.provenance.changeSetId
    );
  }
}

export const provenanceField = StateField.define<RangeSet<ProvenanceValue>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    if (!tr.docChanged) return set;
    const mapped = set.map(tr.changes);
    const provenance = tr.annotation(changeSetAnnotation);
    return provenance ? addMarks(mapped, tr, provenance) : mapped;
  },
});

/**
 * Mark what this change set inserted.
 *
 * A pure deletion inserts nothing and so marks nothing: a zero-width range
 * would render as a bar on a line whose text nobody authored. The deletion is
 * visible in the document itself, which is the honest place for it.
 */
function addMarks(
  set: RangeSet<ProvenanceValue>,
  tr: Transaction,
  provenance: Provenance,
): RangeSet<ProvenanceValue> {
  const value = new ProvenanceValue(provenance);
  const added: Range<ProvenanceValue>[] = [];

  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) added.push(value.range(fromB, toB));
  });

  if (added.length === 0) return set;
  return set.update({ add: added, sort: true });
}

/** The provenance covering `pos`, or null. Used by the tooltip. */
export function provenanceAt(state: EditorState, pos: number): Provenance | null {
  let found: Provenance | null = null;
  state.field(provenanceField).between(pos, pos, (_from, _to, value) => {
    found = value.provenance;
    return false;
  });
  return found;
}
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Full gate and commit**

```bash
npm run check && npm test
```

Expected: clean, and 565 passing (561 today plus 4).

```bash
git add src/services/transactions.ts src/services/workspace.ts src/editor/provenance.ts tests/provenance.test.ts
git commit -m "Record who changed what, as ranges in the document

The annotation carried only a change set id, which is not enough to say
who made a change. It now carries the whole record, so whatever renders
attribution never has to reach back into a bounded log for an answer that
may have rotated out."
```

---

### Task 2: Marks decay as you work

The update rule. A user edit subtracts its own changed ranges, so touching a line takes ownership of it — the marks decay toward zero and an empty gutter means something.

**Files:**
- Modify: `src/editor/provenance.ts` (the `update` function, and a new `subtractChanged`)
- Modify: `tests/provenance.test.ts`

**Interfaces:**
- Consumes: Task 1's `provenanceField`, `ProvenanceValue`
- Produces: no new exports; the field's behaviour changes

- [ ] **Step 1: Write the failing tests**

Append to `tests/provenance.test.ts`:

```ts
/** A plain user edit — no change-set annotation. */
function userEdit(state: EditorState, changes: { from: number; to?: number; insert?: string }): EditorState {
  return state.update({ changes }).state;
}

describe('decaying', () => {
  /**
   * The failure this prevents: marks that never clear, so the gutter fills up
   * over a session and an empty gutter stops meaning anything.
   */
  it('clears the part of a mark you typed into, keeping the rest', () => {
    const marked = applySet(stateWith('aaaabbbbcccc'), { from: 0, to: 12, insert: 'aaaabbbbcccc' });
    expect(marks(marked)).toEqual([[0, 12, 'cs-1']]);

    // Type one character in the middle.
    const edited = userEdit(marked, { from: 6, insert: 'X' });

    // The touched character is unattributed; the two flanks survive.
    expect(marks(edited)).toEqual([
      [0, 6, 'cs-1'],
      [7, 13, 'cs-1'],
    ]);
  });

  /**
   * The failure this prevents: CodeMirror's default range mapping extends a
   * mark when you type at its edge, which is the opposite of "touching a line
   * takes ownership of it".
   */
  it('does not grow a mark when you type at its end', () => {
    const marked = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });

    const edited = userEdit(marked, { from: 3, insert: 'XYZ' });

    expect(marks(edited)).toEqual([[0, 3, 'cs-1']]);
  });

  it('does not grow a mark when you type at its start', () => {
    const marked = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });

    const edited = userEdit(marked, { from: 0, insert: 'XYZ' });

    expect(marks(edited)).toEqual([[3, 6, 'cs-1']]);
  });

  /**
   * The failure this prevents: the position-mapping bug this whole design
   * exists to avoid hand-writing. An edit far from a mark must move it, not
   * corrupt it.
   */
  it('maps a mark past an unrelated edit earlier in the document', () => {
    const marked = applySet(stateWith('aaaa....bbbb'), { from: 8, to: 12, insert: 'bbbb' });
    expect(marks(marked)).toEqual([[8, 12, 'cs-1']]);

    const edited = userEdit(marked, { from: 0, insert: 'XX' });

    expect(marks(edited)).toEqual([[10, 14, 'cs-1']]);
  });

  it('removes a mark whose text was deleted entirely', () => {
    const marked = applySet(stateWith('keep____keep'), { from: 4, to: 8, insert: '____' });

    const edited = userEdit(marked, { from: 4, to: 8 });

    // The failure this prevents: a zero-width ghost surviving the deletion and
    // rendering as a bar on the line that closed over it.
    expect(marks(edited)).toEqual([]);
  });

  /**
   * The failure this prevents: stale authorship after an agent edits its own
   * earlier work — the mark would still name the first change set.
   */
  it('re-attributes a range a second change set overwrites', () => {
    const first = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });
    const second = applySet(first, { from: 0, to: 3, insert: 'xyz' }, record({ changeSetId: 'cs-2' }));

    expect(marks(second)).toEqual([[0, 3, 'cs-2']]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: FAIL. `clears the part of a mark you typed into` returns `[[0, 13, 'cs-1']]` — one extended range rather than two — because `RangeSet.map` grows a range around an insertion inside it. That is exactly the default behaviour this task overrides.

- [ ] **Step 3: Subtract the user's own changes**

In `src/editor/provenance.ts`, change the field's `update` to route user edits through a new function:

```ts
  update(set, tr) {
    if (!tr.docChanged) return set;
    const mapped = set.map(tr.changes);
    const provenance = tr.annotation(changeSetAnnotation);
    return provenance ? addMarks(mapped, tr, provenance) : subtractChanged(mapped, tr);
  },
```

Then add:

```ts
/**
 * Take the ranges this edit touched out of the set.
 *
 * `RangeSet.map` does the opposite of what is wanted here: an insertion inside
 * a range *extends* it, so a mark would swallow your typing and claim an agent
 * wrote it. Subtracting the inserted span splits the mark around what you
 * typed, which is what makes the gutter decay as you review — and an empty
 * gutter is only meaningful if it can be reached.
 */
function subtractChanged(
  set: RangeSet<ProvenanceValue>,
  tr: Transaction,
): RangeSet<ProvenanceValue> {
  const cuts: { from: number; to: number }[] = [];
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    // A pure deletion has nothing to cut: mapping already shrank any mark
    // around the removed text.
    if (toB > fromB) cuts.push({ from: fromB, to: toB });
  });
  if (cuts.length === 0) return set;

  const kept: Range<ProvenanceValue>[] = [];
  const cursor = set.iter();

  while (cursor.value) {
    let pieces = [{ from: cursor.from, to: cursor.to }];
    for (const cut of cuts) {
      const next: { from: number; to: number }[] = [];
      for (const piece of pieces) {
        if (cut.to <= piece.from || cut.from >= piece.to) {
          next.push(piece);
          continue;
        }
        if (cut.from > piece.from) next.push({ from: piece.from, to: cut.from });
        if (cut.to < piece.to) next.push({ from: cut.to, to: piece.to });
      }
      pieces = next;
    }
    for (const piece of pieces) {
      // Zero-width survivors are dropped: a mark with no text is a bar on a
      // line nobody authored.
      if (piece.to > piece.from) kept.push(cursor.value.range(piece.from, piece.to));
    }
    cursor.next();
  }

  return RangeSet.of(kept, true);
}
```

Also change `addMarks` so a change set replaces any attribution under what it inserted, rather than layering on top of it. Replace its final two lines with:

```ts
  if (added.length === 0) return set;
  // A second change set over the same text owns it now; leaving the first
  // mark in place would name the wrong author for text it no longer wrote.
  const covered = set.update({
    filter: (from, to) => !added.some((range) => from < range.to && to > range.from),
  });
  return covered.update({ add: added, sort: true });
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run check && npm test
```

Expected: clean, 571 passing.

```bash
git add src/editor/provenance.ts tests/provenance.test.ts
git commit -m "Clear a mark where you have edited it

CodeMirror's range mapping extends a mark when you type inside it, which
would have a mark swallow your own typing and attribute it to an agent.
Subtracting the edit splits the mark around what you wrote, so the gutter
decays as you review it — an empty gutter only means something if it can
be reached."
```

---

### Task 3: The gutter

A 2px bar on every line a mark intersects. No icon, no animation, no hover state of its own.

**Files:**
- Modify: `src/editor/provenance.ts`
- Modify: `src/editor/theme.ts` (beside the existing `.cm-foldGutter` rules around :123)

**Interfaces:**
- Consumes: Task 1-2's `provenanceField`
- Produces: `export function provenanceGutter(): Extension`

- [ ] **Step 1: Add the gutter**

There is no unit test for this step — it is a rendering concern with no DOM in the test environment, and the field it reads is already covered. It is verified by eye in Task 7's walk.

In `src/editor/provenance.ts`, add the imports:

```ts
import { gutter, GutterMarker } from '@codemirror/view';
```

and:

```ts
/**
 * One bar, shared by every marked line.
 *
 * Deliberately one appearance for all four author kinds. The mark's job is
 * "something other than your typing touched this line" — the tooltip carries
 * who. Four colours in a 2px bar would ask a glance to read more than a glance
 * can.
 */
class ProvenanceMarker extends GutterMarker {
  override toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'nox-provenance-marker';
    return span;
  }
}

const marker = new ProvenanceMarker();

export function provenanceGutter(): Extension {
  return gutter({
    class: 'cm-provenanceGutter',
    lineMarker(view, line) {
      // `between` stops at the first hit: the line either has attribution or
      // it does not, and which change set it came from does not change the bar.
      let hit = false;
      view.state.field(provenanceField).between(line.from, line.to, () => {
        hit = true;
        return false;
      });
      return hit ? marker : null;
    },
  });
}
```

- [ ] **Step 2: Style it**

In `src/editor/theme.ts`, beside the existing fold-gutter rules:

```ts
      '.cm-provenanceGutter': {
        width: '3px',
        padding: '0',
      },
      // Quiet on purpose: this is somewhere to look when you are curious, not
      // something that competes for attention while you work.
      '.cm-provenanceGutter .nox-provenance-marker': {
        display: 'block',
        width: '2px',
        height: '100%',
        background: 'var(--nox-violet-dim)',
      },
```

- [ ] **Step 3: Typecheck**

```bash
npm run check
```

Expected: clean. The gutter is not composed into any buffer yet — Task 5 does that — so nothing renders and the suite is unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/editor/provenance.ts src/editor/theme.ts
git commit -m "Add the provenance gutter

One appearance for every author kind. The bar says something other than
your typing touched this line; the tooltip says who."
```

---

### Task 4: The tooltip

Hover marked text for the author, the change set's description, and when.

**Files:**
- Modify: `src/editor/provenance.ts`
- Modify: `tests/provenance.test.ts`

**Interfaces:**
- Consumes: `provenanceAt` from Task 1
- Produces: `export function provenanceTooltip(): Extension`, `export function describeProvenance(p: Provenance, now: number): string`

- [ ] **Step 1: Write the failing test**

The tooltip's DOM needs a browser, but its *text* is a pure function and that is where the logic is. Append to `tests/provenance.test.ts`:

```ts
import { describeProvenance } from '../src/editor/provenance';

describe('tooltip text', () => {
  const now = 1_700_000_600_000; // ten minutes after the fixture's `at`

  it('names the author and the change', () => {
    expect(describeProvenance(record(), now)).toBe('claude-1 · Rewrite the greeting · 10m ago');
  });

  /**
   * The failure this prevents: "0m ago" for something that just happened,
   * which reads as a bug rather than as freshness.
   */
  it('says "just now" under a minute', () => {
    expect(describeProvenance(record({ at: now - 20_000 }), now)).toBe(
      'claude-1 · Rewrite the greeting · just now',
    );
  });

  it('falls back to hours past sixty minutes', () => {
    expect(describeProvenance(record({ at: now - 7_200_000 }), now)).toBe(
      'claude-1 · Rewrite the greeting · 2h ago',
    );
  });

  /**
   * The failure this prevents: a project replace reading as though someone
   * else did it. `authorLabel` renders `{kind:'user'}` as "You".
   */
  it('renders your own change sets as yours', () => {
    expect(describeProvenance(record({ authorKind: 'user', authorLabel: 'You', description: 'Replace "foo"' }), now))
      .toBe('You · Replace "foo" · 10m ago');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: FAIL — `describeProvenance is not a function`.

- [ ] **Step 3: Implement**

In `src/editor/provenance.ts`, add `hoverTooltip` to the `@codemirror/view` import, then:

```ts
/** "claude-1 · Rewrite the greeting · 10m ago". */
export function describeProvenance(provenance: Provenance, now: number): string {
  const elapsed = Math.max(0, now - provenance.at);
  const minutes = Math.floor(elapsed / 60_000);
  // "0m ago" reads as a bug rather than as freshness.
  const when = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  return `${provenance.authorLabel} · ${provenance.description} · ${when}`;
}

export function provenanceTooltip(): Extension {
  return hoverTooltip((view, pos) => {
    const provenance = provenanceAt(view.state, pos);
    if (!provenance) return null;
    return {
      pos,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-tooltip-provenance';
        dom.textContent = describeProvenance(provenance, Date.now());
        return { dom };
      },
    };
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run check && npm test
```

Expected: clean, 575 passing.

```bash
git add src/editor/provenance.ts tests/provenance.test.ts
git commit -m "Say who made a change on hover

The text is a pure function so it can be tested without a browser; the
tooltip itself is a thin wrapper over it."
```

---

### Task 5: The setting, and the Compartment boundary

Gate the rendering on `workbench.showChangeMarks` — and keep the field out of the compartment, because a compartment reconfigured to nothing destroys the state its extensions hold.

**Files:**
- Modify: `src/services/config/schema.ts` (the Workbench block)
- Modify: `src/editor/extensions.ts` (`compartments`, `CompartmentName`, `SETTING_TO_COMPARTMENTS`, `compartmentContent`, `staticExtensions`)
- Modify: `tests/provenance.test.ts`

**Interfaces:**
- Consumes: `provenanceField`, `provenanceGutter`, `provenanceTooltip`
- Produces: `workbench.showChangeMarks` in `Settings`; a `provenance` compartment

- [ ] **Step 1: Write the failing test**

This is the boundary that loses data silently if it is wrong, so it gets a test that would catch exactly that. Append to `tests/provenance.test.ts`:

```ts
import { buildExtensions } from '../src/editor/extensions';
import { defaultSettings } from '../src/services/config/schema';

describe('the setting', () => {
  /**
   * The failure this prevents: putting the state field inside the compartment.
   * Reconfiguring a compartment to nothing removes its extensions, and
   * removing a StateField destroys the state it holds — so toggling the
   * setting off would silently throw away every mark recorded so far, and
   * toggling it back on would show an empty gutter.
   */
  it('keeps marks recorded while the gutter is hidden', () => {
    const off = { ...defaultSettings(), 'workbench.showChangeMarks': false };
    const state = EditorState.create({ doc: 'hello', extensions: buildExtensions(off) });

    const marked = state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      annotations: changeSetAnnotation.of(record()),
    }).state;

    // Recorded even though nothing is rendering it.
    expect(marks(marked)).toEqual([[0, 7, 'cs-1']]);
  });

  it('records marks with the gutter on, too', () => {
    const state = EditorState.create({ doc: 'hello', extensions: buildExtensions(defaultSettings()) });

    const marked = state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      annotations: changeSetAnnotation.of(record()),
    }).state;

    expect(marks(marked)).toEqual([[0, 7, 'cs-1']]);
  });
});
```

`defaultSettings()` is already exported from `schema.ts` and is what `tests/config.test.ts` uses — no new export is needed for this test.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: FAIL — `'workbench.showChangeMarks' does not exist in type Settings`.

- [ ] **Step 3: Add the setting**

In `src/services/config/schema.ts`, in the Workbench block beside `workbench.showStatusBar`:

```ts
  'workbench.showChangeMarks': bool(true, {
    label: 'Show Change Marks',
    description: 'Mark lines changed by a replace, an agent or a plugin.',
    category: 'Workbench',
  }),
```

- [ ] **Step 4: Compose it**

In `src/editor/extensions.ts`:

Import the three pieces:

```ts
import { provenanceField, provenanceGutter, provenanceTooltip } from './provenance';
```

Add `provenance: new Compartment(),` to the `compartments` object.

Add the setting to `SETTING_TO_COMPARTMENTS`:

```ts
  'workbench.showChangeMarks': ['provenance'],
```

Add the case to `compartmentContent`:

```ts
    case 'provenance':
      return s['workbench.showChangeMarks'] ? [provenanceGutter(), provenanceTooltip()] : [];
```

And — the important part — add the **field** to `staticExtensions()`, not to the compartment:

```ts
    // The field is unconditional; only its rendering is compartmentalised.
    // A compartment reconfigured to nothing removes its extensions, and
    // removing a StateField destroys the state it holds — so gating the field
    // on the setting would throw every mark away the moment it was toggled off.
    provenanceField,
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/provenance.test.ts && npm run check && npm test
```

Expected: PASS, 16 provenance tests; check clean; 577 passing.

- [ ] **Step 6: Commit**

```bash
git add src/services/config/schema.ts src/editor/extensions.ts tests/provenance.test.ts
git commit -m "Gate the change marks on a setting

Only the gutter and the tooltip are compartmentalised. The field itself is
unconditional: a compartment reconfigured to nothing removes what it holds,
so gating the field would discard every mark the moment you hid it."
```

---

### Task 6: Navigation and clearing

Three commands. Navigation is the feature — it turns "an agent touched 12 files" into a review you can walk.

**Files:**
- Modify: `src/editor/provenance.ts`
- Modify: `src/app.ts` (commands, after the Terminal block; the Notes block is there too)
- Modify: `tests/provenance.test.ts`

**Interfaces:**
- Consumes: `provenanceField`
- Produces: `export function nextProvenance(state: EditorState, from: number): { from: number; to: number } | null`, `export function previousProvenance(state: EditorState, from: number): { from: number; to: number } | null`, `export function hasProvenance(state: EditorState): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `tests/provenance.test.ts`:

```ts
import { hasProvenance, nextProvenance, previousProvenance } from '../src/editor/provenance';

describe('navigation', () => {
  /** Two marks: [0,3) from cs-1 and [6,9) from cs-2. */
  function twoMarks(): EditorState {
    const first = applySet(stateWith('abc...def'), { from: 0, to: 3, insert: 'abc' });
    return applySet(first, { from: 6, to: 9, insert: 'def' }, record({ changeSetId: 'cs-2' }));
  }

  it('finds the next mark after the cursor', () => {
    expect(nextProvenance(twoMarks(), 0)).toEqual({ from: 6, to: 9 });
  });

  it('finds the previous mark before the cursor', () => {
    expect(previousProvenance(twoMarks(), 9)).toEqual({ from: 0, to: 3 });
  });

  /**
   * The failure this prevents: wrapping silently, which loses your place in
   * the middle of reviewing a change set that touched several files.
   */
  it('returns null at the last mark rather than wrapping', () => {
    expect(nextProvenance(twoMarks(), 6)).toBeNull();
  });

  it('returns null before the first mark rather than wrapping', () => {
    expect(previousProvenance(twoMarks(), 0)).toBeNull();
  });

  it('reports whether a document has any marks at all', () => {
    expect(hasProvenance(twoMarks())).toBe(true);
    expect(hasProvenance(stateWith('nothing here'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: FAIL — `nextProvenance is not a function`.

- [ ] **Step 3: Implement the helpers**

In `src/editor/provenance.ts`:

```ts
export function hasProvenance(state: EditorState): boolean {
  return state.field(provenanceField).size > 0;
}

/**
 * The first mark starting after `from`, or null.
 *
 * Null rather than wrapping: silently returning to the top is how you lose
 * your place halfway through reviewing a change set.
 */
export function nextProvenance(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(provenanceField).between(from + 1, state.doc.length, (start, end) => {
    if (start > from) {
      found = { from: start, to: end };
      return false;
    }
    return undefined;
  });
  return found;
}

/** The mirror of `nextProvenance`. */
export function previousProvenance(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(provenanceField).between(0, Math.max(0, from - 1), (start, end) => {
    if (end < from || start < from) found = { from: start, to: end };
    return undefined;
  });
  return found;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/provenance.test.ts
```

Expected: PASS, 21 tests.

- [ ] **Step 5: Add the clear effect**

The commands need a way to empty the field. In `src/editor/provenance.ts`, add `StateEffect` to the `@codemirror/state` import and:

```ts
/** Drop every mark in this buffer. The "Clear Change Marks" command. */
export const clearProvenanceEffect = StateEffect.define<null>();
```

and handle it first in the field's `update`, before anything else:

```ts
  update(set, tr) {
    if (tr.effects.some((effect) => effect.is(clearProvenanceEffect))) return RangeSet.empty;
    if (!tr.docChanged) return set;
    ...
  },
```

Add a test for it, appended to the `navigation` describe block:

```ts
  it('clears every mark in the buffer', () => {
    const cleared = twoMarks().update({ effects: clearProvenanceEffect.of(null) }).state;

    // The failure this prevents: clearing only the marks the cursor is in,
    // leaving the rest to look like they were missed rather than dismissed.
    expect(marks(cleared)).toEqual([]);
  });
```

with `clearProvenanceEffect` added to the import from `../src/editor/provenance`.

- [ ] **Step 6: Register the commands**

In `src/app.ts`, in `#registerCommands`, after the Notes block:

```ts
      // --- Change marks -----------------------------------------------------
      {
        id: 'provenance.nextChange',
        title: 'Go to Next Change',
        category: 'Change Marks',
        keywords: ['provenance', 'author', 'agent', 'replace'],
        enabled: () => this.#activeHasProvenance(),
        run: () => this.#goToProvenance('next'),
      },
      {
        id: 'provenance.previousChange',
        title: 'Go to Previous Change',
        category: 'Change Marks',
        keywords: ['provenance', 'author', 'agent', 'replace'],
        enabled: () => this.#activeHasProvenance(),
        run: () => this.#goToProvenance('previous'),
      },
      {
        id: 'provenance.clear',
        title: 'Clear Change Marks',
        category: 'Change Marks',
        keywords: ['provenance', 'dismiss', 'reset'],
        enabled: () => this.#activeHasProvenance(),
        run: () => this.#clearProvenance(),
      },
```

And the three private helpers, beside the other view-driven helpers:

```ts
  #activeHasProvenance(): boolean {
    const view = this.view.get();
    return view ? hasProvenance(view.state) : false;
  }

  /**
   * Move the cursor to the next or previous marked region.
   *
   * Says so when there is nothing further rather than wrapping: a review that
   * silently returns to the top is a review you lose your place in.
   */
  #goToProvenance(direction: 'next' | 'previous'): void {
    const view = this.view.get();
    if (!view) return;
    const from = view.state.selection.main.head;
    const target =
      direction === 'next'
        ? nextProvenance(view.state, from)
        : previousProvenance(view.state, from);

    if (!target) {
      this.notifications.info(
        direction === 'next' ? 'No later changes in this file' : 'No earlier changes in this file',
      );
      return;
    }

    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      scrollIntoView: true,
    });
    view.focus();
  }

  #clearProvenance(): void {
    const view = this.view.get();
    if (!view) return;
    view.dispatch({ effects: clearProvenanceEffect.of(null) });
  }
```

Import at the top of `app.ts`:

```ts
import {
  clearProvenanceEffect,
  hasProvenance,
  nextProvenance,
  previousProvenance,
} from '@editor/provenance';
```

- [ ] **Step 7: Full gate and commit**

```bash
npm run check && npm test
```

Expected: clean, 578 passing.

```bash
git add src/editor/provenance.ts src/app.ts tests/provenance.test.ts
git commit -m "Walk between changes, and dismiss them

Navigation is the point: it turns 'something touched twelve files' into a
review you can actually walk. It stops at the ends and says so rather than
wrapping, because a review that silently returns to the top is one you
lose your place in."
```

---

### Task 7: Verify in the running app, and document it

**Files:**
- Modify: `ARCHITECTURE.md` (§3 tree, and a §4 subsection)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Walk it in the running app**

```bash
npm run dev
```

This project has repeatedly shipped bugs a green suite missed, so this is the real gate. Confirm each by observing it:

1. Open two or three files from the demo workspace. Run a project-wide replace (`Mod+Shift+F`, replace mode) that matches in several of them.
2. The changed lines carry a thin violet bar in a gutter right of the line numbers. It should read as texture — if it grabs your eye, it is too strong.
3. Hover a changed line's *text*: the tooltip says `You · Replace "…" · just now`.
4. Type in the middle of a marked region. The bar disappears from what you typed, and survives on the rest of the line if any of it is untouched.
5. `Mod+Shift+P` → "Go to Next Change" walks the marks. At the last one it says "No later changes in this file" rather than wrapping.
6. All three commands appear under **Change Marks**, and are greyed in a file with no marks.
7. Settings (`Mod+,`) → **Show Change Marks** off: the gutter disappears. Turn it back on: **the marks are still there.** This is the Compartment boundary — if they came back empty, the field is in the compartment and Task 5 is wrong.
8. "Clear Change Marks" empties the gutter.

Fix anything that fails and re-walk that step. Record what you actually observed.

- [ ] **Step 2: Add the §4 subsection**

In `ARCHITECTURE.md` §4, after the notes subsection, matching the neighbours' voice — decision, rejected alternative, what it cost:

```markdown
### Provenance is state, not a view

Search highlighting is a `ViewPlugin` because matches are *derivable*: given
the query and the document, you can always recompute them. Provenance is not.
Once a change set is applied, nothing in the document remembers who did it, so
it has to be recorded as it happens and carried forward — which makes it a
`StateField` holding a `RangeSet`, mapped through every later change by
CodeMirror rather than by hand.

The alternative was a position index maintained in the workspace. It would
have reimplemented `RangeSet.map` and forced the workspace to intercept every
transaction to keep it current. Putting it in state also means background
buffers accumulate provenance correctly, because the workspace updates their
state whether or not a view exists.

Two costs are real. A user's edit has to *subtract* its own changed ranges,
because CodeMirror's default mapping extends a mark when you type inside it —
the opposite of "touching a line takes ownership of it". And the field must
stay out of the settings `Compartment`: reconfiguring a compartment to nothing
removes its extensions, and removing a `StateField` destroys what it holds, so
only the gutter and the tooltip are gated by `workbench.showChangeMarks`.

Marks live for the session and no longer, for the same reason the transaction
log does: persisting them would decouple provenance from undoability, and a
`git checkout` or an external formatter would leave attribution that is
confidently wrong. A mark that lies is worse than no mark.
```

- [ ] **Step 3: Add the §3 tree entry**

§3 is an indented tree, not a table, and lists `editor/` file by file. Add between `find.ts` and `folding.ts`, keeping the box-drawing characters and the column alignment of its neighbours (measure them; do not assume):

```
│  ├─ provenance.ts      Who changed what, as ranges. Gutter and tooltip.
```

- [ ] **Step 4: Add the changelog entry**

Under `## [Unreleased]`'s `### Added` block, matching the bolded-lead-phrase style of its neighbours:

```markdown
- **Change marks.** Lines changed by a project replace, an agent or a plugin
  carry a quiet bar in the gutter, and hovering says who changed them and why.
  **Go to Next Change** walks them.
  - Typing in a marked region clears the mark there, so the gutter decays as
    you review rather than accumulating all session.
  - Marks last for the session. Persisting them would mean attribution that a
    `git checkout` could silently make wrong.
  - **Show Change Marks** turns the gutter off for anyone who finds it noisy.
```

- [ ] **Step 5: Final verification**

```bash
npm run check && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

Report the actual numbers. Expect check clean, 578 TypeScript, 35 Rust.

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "Document change provenance

Why it is a StateField rather than a ViewPlugin, and the two costs that
choice carries: subtracting the user's own edits, and keeping the field
out of the settings compartment."
```

---

## Notes for the executor

- **Task 3 has no unit test.** That is deliberate — it is rendering, in an environment with no DOM, reading a field that is already covered. It is verified by eye in Task 7. Do not invent a test to fill the gap.
- **Two rows of the spec's §9 test table have no test of their own, on purpose.** "A change set that has rotated out of the log still has a full tooltip" is structurally guaranteed rather than behavioural: `provenance.ts` never imports `TransactionLog`, so there is nothing that could go stale, and a test would assert the absence of an import. "Marks accumulate in a background buffer with no view" is covered by every test in the file — they all drive a bare `EditorState` with no view attached, which *is* the background-buffer case. If either stops being true, it will be because someone added a log dependency or a view requirement, and that is a review question rather than a test one.
- **The `previousProvenance` helper is the fiddliest thing here.** `RangeSet.between` iterates forward, so finding the *last* match before a position means letting the callback overwrite `found` rather than returning `false` early. Read the test before the implementation.
- **Do not add a keybinding.** The palette is the right first home; chords are scarcer than commands.
- **Task 5's test is the one that matters most.** If the field ends up in the compartment, everything still looks fine until someone toggles the setting — and then their marks are gone with no error.
