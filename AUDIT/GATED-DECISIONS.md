# The eleven Gated findings

Each of these needs your answer, not more work. They are Gated because fixing them would change a public API, an on-disk or config format, a keybinding default, or the permission and agent capability boundaries. Nothing below has been touched.

Ordered by what I would decide first.

---

## 1. A7-001 (P1): may a non-user principal run a command that declares no capabilities?

**Today.** The dispatcher checks `command.capabilities?.length`, so a command declaring nothing is never checked, for any principal. `src/services/commands.ts` is byte-identical between the audited commit and today.

**What already happened.** Your own security review on 2026-08-30 found twelve such commands and gave them declarations, and pinned the set with `tests/command-capabilities.test.ts`. The exploitable instances my audit found are closed by that work. Its comment argues for a list over a rule: there is no way to ask a `run` function whether it reaches the OS, so what is checkable is the set.

**The decision.** Keep the list, or add the rule: a non-user principal may only execute a command that declares capabilities.

| | List (today) | Rule |
|---|---|---|
| A thirteenth undeclared command | Needs a hand edit that a reviewer sees | Refused by default, no review needed |
| Cost | A reviewer has to notice | Every genuinely capability-free command must be declared as such |
| Failure mode | Someone adds a command and updates the list without thinking | An agent workflow breaks until a declaration is added |

**My view: add the rule, keep the list.** They are not alternatives. The rule makes the failure safe, the list keeps it visible. The list alone means the guarantee is "someone looked", which is the thing the audit found had failed once already.

**What it breaks.** Under the shipped policy an agent that silently runs `review.keepAll` today would start prompting. That is the point, and it is why this is Gated.

---

## 2. A8-001 (P1): the stray `v0.12.0` tag

**Today.** A `v0.12.0` tag sits on the public remote pointing at `54cece6`, where every version file reads `0.11.0`. Its release run failed at the version gate in 15 seconds, so no release exists. A later commit prepared 0.12.0 properly, and no tag was cut against it.

**The decision.** Delete the tag, or move it.

Deleting a published ref is outside what I will do without you saying so. Moving a tag is worse than deleting one: anyone who fetched it keeps the old target.

**My view: delete it, then tag the prepared commit.** The tag currently promises a release that does not exist and cannot be produced from what it points at.

---

## 3. A1-001, Gated half (P1): file associations and single instance

**Today.** The Safe half is fixed and merged into [#187](https://github.com/francescoa27122/nox-editor/pull/187): argv paths and the macOS open event now open files. What is still missing is being *offered* as an opener.

**The decision, in two parts.**

- **File associations.** Should the installers register Nox for `.txt`, `.md` and code extensions? This changes what double-clicking a file does on machines that already have Nox, which is why it is Gated. It is also the difference between an editor and a thing you drag files onto.
- **Single instance.** Should a second launch reuse the running window? Without it, opening two files from the OS gives two Nox windows with separate sessions, and the second may overwrite the first's session on quit.

**My view: do both, and single instance first.** The session-overwrite risk is the sharper edge, and it gets worse the moment associations exist.

---

## 4. A7-004 (P2): should the agent context reader be scoped to the workspace?

**Today.** An agent can read any path the user can, and the brief it receives carries the active selection of any file, not only workspace files.

**The decision.** Scope reads to the workspace root, or leave them open.

**My view: scope it.** The README already describes the read door as a workspace-shaped thing. But it is Gated because an agent that legitimately reads a file outside the root, a config file, a sibling checkout, would stop working, and I do not know whether you have one.

---

## 5. A4-004 (P2): a large-file mode below the 64 MB refusal

**Today.** Nox refuses above 64 MB. Below it, everything runs: full-text language server sync on every change, a full-copy session backup with an fsync, and the gutter diff.

**The decision.** Add a threshold, perhaps 5 or 10 MB, above which those are switched off, or keep one behaviour for everything under 64 MB.

**My view: add it.** This is the last real performance cliff, and the branch fixes made the ones above it cheap enough that this is now the worst case.

---

## 6. A1-004 (P2): indentation detection and `.editorconfig`

**Today.** The indent unit is a pure function of settings. A file indented differently from your preference is re-indented as you type.

**The decision.** Detect per file, honour `.editorconfig`, or neither.

**My view: detect, and read `.editorconfig`.** Every editor a user is coming from does. It is Gated because it changes what a keypress inserts in files people already have open.

---

## 7. A6-007 (P3): should `files.excludeFromExplorer` be workspace-scoped?

**Today.** It is one of the eight workspace-scoped keys, so a cloned repository can hide its own entries from the explorer. Search still finds them.

**The decision.** Leave it, or drop it to user scope.

**My view: leave it, and say so in the schema comment.** Hiding build output is the feature working. The threat, a repository hiding a file from a casual reader, is real but weak, since search and the OS both still show it.

---

## 8 to 11. Three keybinding defaults and one focus behaviour

Each changes a default, which is why they are Gated. Each is small.

- **A1-007 (P3).** Go to Line is `Alt+G` off macOS because `Ctrl+G` went to Find Next. Most editors give `Ctrl+G` to Go to Line. **My view: swap them.**
- **A5-003 (P3).** `Alt` does not open the Windows and Linux menu bar, and there are no mnemonics. `F10` is the only keyboard route. **My view: add `Alt` and mnemonics.** It is the platform convention, and the bar already exists.
- **A5-009 (P3).** The editor is a keyboard trap with no documented exit, and the status bar cannot be reached by Tab. **My view: add a toggle-tab-focus command**, as VS Code has. This is an accessibility gap, not a preference.
- **A7-002 (P2).** Closed entirely by the rule in decision 1. If you take that, this needs nothing.
