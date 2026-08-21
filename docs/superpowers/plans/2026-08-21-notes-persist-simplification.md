# Notes Persistence Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear notes' dirty state *before* each write instead of after, deleting the four revision counters that exist only to prove "is this still what I wrote".

**Architecture:** `NotesService.#doPersist` currently writes, then compares a revision captured before the write against the revision now, to decide whether the write is still current. Reversing that — remove the dirty marker before the await, let any mutation landing during the await re-arm it — makes the comparison unnecessary. `#bodyRevision`, `#nextRevision`, `#indexRevision` and `#savedIndexRevision` all disappear; the three per-call failure fences stay.

**Tech Stack:** TypeScript, Svelte 5 runes, vitest, `MemoryPlatform` fake.

**Spec:** `docs/superpowers/specs/2026-08-21-notes-design.md` — this plan implements §1 (Phase 0) only. See "Why this plan stops here" below.

## Global Constraints

- **No behaviour change.** Every one of the 1605 tests, and specifically all of `tests/notes.test.ts`, must pass **unmodified**. Editing a notes test during this plan is a failure signal, not a fix.
- **No new tests.** Spec §1.3: the existing 761-line suite passing unchanged *is* the deliverable. Adding a test here would test the new implementation rather than the preserved behaviour.
- **`NotesService` keeps exactly one dependency** — `Platform`. Nothing in this plan adds another.
- **The failure fences stay.** `failed`, `failedReleases` and `indexFailed` are not part of the revision machinery. Spec §1.2.
- **Abandon is a valid outcome.** If Task 2 or Task 3 cannot keep the suite green after a genuine attempt, revert the branch and record why. Nothing downstream depends on this landing.

## Why this plan stops here

Spec §2.2 and §3.1 specify `pin()` and `setAnchor()` differently depending on whether this refactor landed — `#indexDirty = true` versus `#indexRevision = #nextRevision++`. A plan for those features written now would hard-code one of two futures. They get their own plans once this one resolves either way.

---

### Task 1: Establish the green baseline

**Files:**
- Modify: none
- Test: `tests/notes.test.ts` (run only)

**Interfaces:**
- Consumes: nothing
- Produces: a recorded pass count that Tasks 2 and 3 must reproduce exactly

This task exists because the entire safety argument is "the suite passed before and after". That claim needs a *before* that was actually observed, not assumed.

- [ ] **Step 1: Run the notes suite alone and record the count**

```bash
npx vitest run tests/notes.test.ts
```

Expected: PASS. Write the exact test count down — it is the number Task 3 must match.

- [ ] **Step 2: Run the full gate**

```bash
npm test && npm run check
```

Expected: 1605 passed, 106 files; svelte-check 0 errors 0 warnings.

- [ ] **Step 3: Create the branch**

```bash
git checkout -b refactor/notes-persist-simplification
```

---

### Task 2: Clear body dirty state before the write

**Files:**
- Modify: `src/services/notes.ts` — `setBody`, `create`, `remove`, `#doPersist`
- Test: `tests/notes.test.ts` (run only, unmodified)

**Interfaces:**
- Consumes: the baseline count from Task 1
- Produces: `#bodyRevision` deleted; `#dirtyBodies: Set<string>` remains the only body-dirty state

> **Corrected during execution.** This originally also deleted `#nextRevision`,
> which does not compile: its last user is `#indexRevision`, removed in Task 3.
> `#nextRevision` goes there instead, so that each task is independently green.

- [ ] **Step 1: Confirm the behaviour being preserved, before touching anything**

Run the interleaving tests that define it:

```bash
npx vitest run tests/notes.test.ts -t "in flight"
```

Expected: PASS, **4 tests** (`notes.test.ts:227`, `:260`, `:294`, `:447`). These are the ones that catch a wrong refactor — read them before editing, because they describe the exact interleaving the revision counters exist for.

Two more cover the same hazard without matching that filter, and are worth reading too: `:511` ("two renames that each land during a different pass of the same flush") and `:696` ("a rename that lands during the index write `select()` itself triggers"). `:511` is the case a boolean would get wrong if the flag were cleared *after* the write — which is precisely why Task 3 clears it before.

- [ ] **Step 2: Delete the body revision fields**

In `src/services/notes.ts`, remove both field declarations and their doc comments:

```ts
  #bodyRevision = new Map<string, number>();
  #nextRevision = 1;
```

- [ ] **Step 3: Remove the revision bumps from the three mutators**

In `create()`, delete this line (keep `this.#dirtyBodies.add(id)`):

```ts
    this.#bodyRevision.set(id, this.#nextRevision++);
```

In `setBody()`, delete the same line (keep `this.#dirtyBodies.add(id)`).

In `remove()`, delete:

```ts
    this.#bodyRevision.delete(id);
```

- [ ] **Step 4: Invert the body drain in `#doPersist`**

Replace the body of the inner drain loop. Before:

```ts
        const revisionAtStart = this.#bodyRevision.get(id);
        const problem = await this.#write(file, note.body);
        if (problem) {
          failure ??= problem;
          failed.add(id);
          continue;
        }
        if (this.#bodyRevision.get(id) === revisionAtStart) this.#dirtyBodies.delete(id);
```

After:

```ts
        // Cleared *before* the write, not after. A setBody landing while the
        // write is in flight puts the id straight back, which is the whole
        // mechanism — there is no revision to capture and compare.
        this.#dirtyBodies.delete(id);
        const problem = await this.#write(file, note.body);
        if (problem) {
          // Until this write lands the text exists nowhere but memory, so
          // re-arm. `failed` stops this same call retrying it forever.
          this.#dirtyBodies.add(id);
          failure ??= problem;
          failed.add(id);
        }
```

Note the `continue` is gone: the failure branch no longer needs to skip anything, because success now does no work.

- [ ] **Step 5: Run the notes suite**

```bash
npx vitest run tests/notes.test.ts
```

Expected: PASS, at the exact count recorded in Task 1. A failure here means the interleaving is wrong — fix `notes.ts`, never the test.

- [ ] **Step 6: Commit**

```bash
git add src/services/notes.ts
git commit -m "Clear a note's dirty flag before its write, not after"
```

---

### Task 3: Replace the index revision pair with one boolean

**Files:**
- Modify: `src/services/notes.ts` — `rename`, `select`, `remove`, `#doPersist`
- Test: `tests/notes.test.ts` (run only, unmodified)

**Interfaces:**
- Consumes: Task 2's inverted body drain
- Produces: `#indexRevision` and `#savedIndexRevision` deleted, replaced by `#indexDirty: boolean`

- [ ] **Step 1: Swap the two counters for one flag**

Remove `#indexRevision` and `#savedIndexRevision` with their doc comments, and add:

```ts
  /**
   * Whether index-shaped state — a title, the selection, list membership —
   * has moved since the last index write started. Set by `rename()`,
   * `select()` and `remove()`, which carry no dirty body to ride on.
   *
   * A plain boolean rather than the revision pair this replaced: because the
   * flag is cleared *before* the write rather than after, a change landing
   * mid-write simply sets it again, and "unchanged since the write started"
   * no longer has to be distinguished from "changed back to the same value".
   */
  #indexDirty = false;
```

- [ ] **Step 2: Update the three index-only mutators**

In `rename()`, `select()` and `remove()`, replace each occurrence of:

```ts
    this.#indexRevision = this.#nextRevision++;
```

with:

```ts
    this.#indexDirty = true;
```

- [ ] **Step 3: Update the `create()` invariant comment — do not delete it**

`create()` carries a comment beginning "Deliberately does not bump #indexRevision" explaining why it must never do so. Change `#indexRevision` to `#indexDirty` in it and leave `create()`'s code alone.

> **Corrected during execution.** This step originally said to delete the
> comment, on the grounds that the hazard was gone. It is not gone. A new note
> still rides on its dirty body to keep a pass alive, and the index write in
> that pass is still unconditional and still reads notes fresh — so `create()`
> still must not set the flag itself, and the comment still records a live
> constraint. Deleting it would have dropped the invariant, not retired it.

- [ ] **Step 4: Invert the index write**

In `#doPersist`, replace:

```ts
      const revisionAtStart = this.#indexRevision;
      const problem = await this.#write(INDEX_FILE, JSON.stringify(data));
      if (problem) {
        failure ??= problem;
        indexFailed = true;
      } else if (this.#indexRevision === revisionAtStart) {
        this.#savedIndexRevision = revisionAtStart;
      }
```

with:

```ts
      // Cleared before the write for the same reason as a body: a rename or
      // a selection landing during the await sets it again by itself.
      this.#indexDirty = false;
      const problem = await this.#write(INDEX_FILE, JSON.stringify(data));
      if (problem) {
        this.#indexDirty = true;
        failure ??= problem;
        indexFailed = true;
      }
```

- [ ] **Step 5: Update the loop's exit check**

Replace:

```ts
      const stillIndexDirty = this.#indexRevision !== this.#savedIndexRevision && !indexFailed;
```

with:

```ts
      const stillIndexDirty = this.#indexDirty && !indexFailed;
```

- [ ] **Step 6: Confirm the four fields are gone**

```bash
grep -n "bodyRevision\|nextRevision\|indexRevision\|savedIndexRevision" src/services/notes.ts
```

Expected: no output. Any hit is a missed reference.

- [ ] **Step 7: Run the notes suite, then the full gate**

```bash
npx vitest run tests/notes.test.ts && npm test && npm run check
```

Expected: notes at Task 1's exact count; 1605 passed; 0 errors 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add src/services/notes.ts
git commit -m "Track index dirtiness with a boolean, not a revision pair"
```

---

### Task 4: Retire the debt entry and the class doc it justified

**Files:**
- Modify: `ARCHITECTURE.md` — the `notes.ts`/`#doPersist` row in §7 Known debt
- Modify: `src/services/notes.ts` — class doc comment, if it references revisions
- Test: `npm test` (run only)

**Interfaces:**
- Consumes: Tasks 2 and 3 complete
- Produces: documentation matching the code

A refactor that leaves its own debt entry standing tells the next reader the work is still owed.

- [ ] **Step 1: Delete the debt row**

In `ARCHITECTURE.md` §7, remove the table row beginning:

```
| `notes.ts`'s `#doPersist` clears dirty state after the write, not before |
```

- [ ] **Step 2: Check the notes section for stale claims**

```bash
grep -n "revision" ARCHITECTURE.md src/services/notes.ts
```

Read each hit. Any sentence describing the revision-comparison technique as current is now false and must be rewritten or removed.

- [ ] **Step 3: Run the full gate**

```bash
npm test && npm run check
```

Expected: 1605 passed; 0 errors 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md src/services/notes.ts
git commit -m "Retire the #doPersist debt entry it was written against"
```

---

### Task 5: Ship it

**Files:** none

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin refactor/notes-persist-simplification
```

PR body must state: no behaviour change, no test changes, and the line count removed.

- [ ] **Step 2: Confirm the diff touches no test file**

```bash
git diff origin/main... --stat -- tests/
```

Expected: no output. Output here means the safety argument was broken somewhere and the PR is not ready.

- [ ] **Step 3: Queue the merge behind CI**

```bash
gh pr merge --auto --merge --delete-branch
```

`main` requires all seven checks (`rust` on macOS/ubuntu/windows, `web` on ubuntu×windows × node 20/22) and `enforce_admins` is on, so this waits rather than merging.

## Self-Review

**Spec coverage.** Spec §1.1 → Tasks 2 and 3. §1.2 (fences stay) → Global Constraints, and Task 2 Step 4 keeps `failed`. §1.3 (ships alone, no new tests, abandonable) → Global Constraints and Task 5 Step 2. Spec §2–§4 are deliberately out of scope, stated under "Why this plan stops here". No gaps.

**Placeholder scan.** Every code step carries the actual before/after text. No "similar to", no "handle errors appropriately".

**Type consistency.** `#indexDirty` is declared in Task 3 Step 1 and used in Steps 2, 4 and 5 under that exact name. `#dirtyBodies` keeps its existing `Set<string>` type throughout. The four deleted fields are checked absent by Task 3 Step 6.

**One deliberate deviation from TDD.** There is no failing test to write first, because the deliverable is *preserved* behaviour — spec §1.3. The equivalent discipline is Task 1: observe green before, reproduce the exact count after. A refactor whose baseline was never observed has no safety argument at all.
