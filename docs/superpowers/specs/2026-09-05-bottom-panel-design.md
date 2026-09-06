# The bottom panel

**Status:** approved 2026-09-05, as one of the five UI changes a daily user
will feel. Supersedes §7 of `2026-08-30-tasks-design.md`, which put Tasks in
the editor slot and recorded this as the second pass.

## 1. The problem

Running a task took over the editor area. The code you were building
disappeared while it built, which is the opposite of what a task panel is
for: the terminal's own comment (`services/ui.ts`, `terminalOpen`) says the
whole point of a terminal in an editor is watching a build fail *next to* the
code that failed, and a task is a build. Two Known-debt rows recorded it:
"Tasks would rather be a bottom panel than an editor one" and "A fifth panel
in the editor slot costs a line in each of the other four".

## 2. The shape

One container below the editor, `ui/BottomPanel.svelte`, with a tab strip:
**Terminal** (where the platform has terminals) and **Tasks**. One view shows
at a time. The container takes `terminal.height`, which keeps every existing
settings file meaning what it meant; the setting's label now says *Panel
Height*.

The strip carries the actions that used to sit in each panel's own header,
so a view is one bar and its body rather than two bars: for the terminal,
the exit note and **Restart**; for tasks, **Forget approved**, **Stop All**
and **Edit Tasks**. **Hide** on the right closes whichever view is showing.
Every button dispatches a command, as every button in Nox does.

`TerminalPanel` and `TasksPanel` lose their headers and keep their bodies.
The terminal stays mounted once opened and hidden with CSS, for the reason it
always has: unmounting throws the scrollback away.

## 3. State

`UIService` keeps `terminalOpen` and `tasksOpen` as they are, with one new
invariant: **at most one is true.** `focusTerminal` clears `tasksOpen`;
`showTasks` clears `terminalOpen`. A new `bottomView` remembers which of the
two was showing last, so **Toggle Bottom Panel** (`Mod+J`, the chord VS Code
uses) reopens the view you closed rather than always the terminal.

Keeping the two signals rather than replacing them with one
`bottomPanel: 'terminal' | 'tasks' | null` was a deliberate trade: the
status bar, `TerminalPanel`, `dismissTop`, `hasDismissible` and a dozen
tests read `terminalOpen`, and a rename that touched all of them would have
made a change about where a panel sits into a change about how the shell is
wired. The invariant is held by `tests/bottom-panel.test.ts`.

`showAgents`, `showDiff` and `showWelcome` no longer clear `tasksOpen`,
because tasks are no longer in the slot they share. The slot is back to four
panels, which is where it was before the tasks row; the N-by-N debt row
stays, at four.

## 4. Escape

Unchanged. `dismissTop` still closes the tasks view before the welcome
screen, and still leaves a running task alone: putting a window away is not a
reason to kill a build half way through, which is `hideTerminal`'s rule and
the same one.

## 5. Surface

| Command | Id | Chord |
|---|---|---|
| Toggle Bottom Panel | `view.toggleBottomPanel` | `Mod+J` |

Declares nothing: it shows or hides a panel and starts no process. Opening
the terminal view goes through `terminal.focus`, which declares `shell.exec`
and is enabled only where a shell exists; the toggle falls back to the tasks
view where there is none.

## 6. Tests

- One view at a time, and `bottomView` follows the last one shown.
- Showing tasks leaves the agents panel alone: with a file open, the editor
  is still on screen beside the tasks view (mounted `App.svelte`).
- The toggle reopens the last view, falls back to tasks with no terminal, and
  answers `Mod+J`.
- The strip's tabs and Hide dispatch the commands they name.

## 7. Not done

- Problems and References stay in the sidebar. They are lists, not output,
  and they have chords and a rail position people have learned.
- No drag-to-resize on the panel's top edge yet. `terminal.height` is a
  setting, as it was.
