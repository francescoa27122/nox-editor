# Damaged config files — design

Four files Nox reads at boot are discarded without a word when they will not
parse, and then overwritten by the next ordinary write. Each of the four holds
something the user cannot get back.

Status: approved 2026-08-22.

Everything below was read out of the four load paths, not remembered.

## 1. The defect, four times

| File | Load path | What the silent discard costs |
|---|---|---|
| `settings.json` | `src/services/config/index.ts:229` — `return; // Corrupt file: fall back to defaults` | `#user` stays `{}`. The next `set()` serializes an empty diff and `#save()` atomically replaces the file. **Every customisation, gone**, with no toast. |
| `keybindings.json` | `src/services/keymap.ts:415` — `return; // Corrupt: the defaults stand.` | `#userRules` stays empty; the next rebind writes the file with one rule in it. **Every rebinding, gone.** |
| `session.json` | `src/services/session.ts:396,420,423` — `return null` on a parse failure *or* an unrecognised version | An empty window, and worse: `#nextBackup` restarts at `1` (`:122`), so the first dirty buffer's backup **overwrites `unsaved-1.txt`** — a file that holds genuinely unsaved text. |
| `notes.json` | `src/services/notes.ts:153,155` — `return` on a parse failure, a version mismatch, or a non-array | `#nextOrdinal` restarts at `1`, so the next new note writes **over `note-1.txt`**. The field's own comment says it is "recomputed on load from the ids actually present, so a restart cannot reissue one and overwrite the body file of an existing note" — a guarantee that holds in every case except the one where it matters. |

`servers.json` and `agents.json` already do the right thing
(`src/services/lsp/registry.ts:110`, `src/services/agent/config.ts:137`): they
publish the parse error and say so. Neither is ever written back by Nox, which
is why nobody noticed the other four. **The asymmetry is the bug**, and those
two are the model.

Against `README.md`'s "It does not lose your work. Ever.", the session row is
the one that reads worst.

## 2. What a damaged file is treated as now, and what it should be

Now: **absent.** Absent is a state Nox knows how to handle — start from
defaults and write your own file over the top. That is correct for a file that
genuinely is not there and destructive for one that is.

Instead: **damaged.** A damaged file is evidence. It is preserved, it is
reported, and whatever can still be read out of it is used.

## 3. Three parts

### 3.1 Preserve — a copy under a name Nox will not write

The raw text is copied to `<base>.damaged.<ext>` — `settings.damaged.json`,
`keybindings.damaged.json`, `session.damaged.json`, `notes.damaged.json` — in
the same config directory. Nox never reads or writes those names for any other
purpose, so the copy survives every later save.

The **original is left in place**, not deleted. Nox does not delete a user's
file to fix its own problem; the copy is the preservation, and the original
will be overwritten by the next legitimate write, which is now acceptable
*because the copy exists and the user was told*.

The copy is rewritten on each damaged load rather than kept as a series. It
therefore always mirrors the file that is currently damaged, which is the one
worth repairing. A quarantine whose own write fails changes nothing else: the
damage is still reported, and the report says the copy could not be made.

### 3.2 Report — a signal that a save cannot clear

Each of the four services already has an `error` signal, and `app.ts` already
toasts all four (`src/app.ts:479-511`). **This does not reuse it.** `error`
means "the last *write* failed", and `ConfigService.#save` clears it on the
next write that lands — which would erase a damage notice about 250 ms after
it appeared.

So: a second signal, `damaged`, holding `{ file, copy } | null`, set once at
load and never cleared by a write. Wired beside the four `error`
subscriptions, with a message that says which file, where the copy is, and
what was lost.

### 3.3 Salvage — read the ordinals out of the wreckage

`session.json` and `notes.json` both allocate filenames from a counter that is
"recomputed on load", and both restart at 1 when the load fails. That is what
turns a damaged index into a *destroyed body file*.

`JSON.parse` failing does not make the text unreadable — it makes it
unstructured. The names are still in it. A regex over the raw text for
`unsaved-(\d+)\.txt` and for `"n(\d+)"` recovers the high-water mark from a
truncated or corrupt file just as well as from a valid one, and the counter
starts above it.

This is deliberately not an attempt to recover the *content* of a damaged
index. It recovers exactly one number, which is all that is needed to stop the
next write landing on top of a file that still holds the user's text.

## 4. Version mismatches count as damage

`session.json` and `notes.json` also return early on a version they do not
recognise. That is not corruption — it is usually a newer Nox having written
the file, i.e. a downgrade — but the consequence is identical: discarded, then
overwritten. Both are treated as damage and both are preserved. The user's tabs
should not be the price of running an older build once.

Versions Nox *does* recognise keep migrating exactly as they do today
(`session.ts:403-418`); only the unrecognised ones are preserved.

## 5. What this is not

- **Not a repair.** Nox does not attempt to fix a damaged file, merge a partial
  one, or guess at a truncated object. It preserves, reports, and starts clean.
- **Not a prompt.** Boot does not stop to ask a question. The window opens; the
  toast says what happened.
- **Not a backup scheme.** There is still exactly one live copy of each of
  these files. Writing a `.bak` on every save is a different feature with a
  different cost, and it would not have prevented any of the four losses above.

## 6. Failure paths

| Case | Behaviour |
|---|---|
| File absent | Unchanged — no copy, no report. Absent is not damaged. |
| File empty / whitespace | Unchanged. An empty file is how `clear()` marks a released session. |
| Parse failure | Copy, report, defaults; counters salvaged from the raw text |
| Unrecognised version | Copy, report, defaults; counters salvaged |
| Recognised older version | Migrated as today; no copy, no report |
| The copy's own write fails | Damage still reported, and the report says the copy failed |
| `readConfigFile` throws | Unchanged — unreadable is not the same as damaged, and there is nothing to copy |
| Two damaged files in one boot | Two reports; each writes its own copy |
