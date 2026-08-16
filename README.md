<div align="center">

# Nox

**A fast, dark, keyboard-first text editor.**

*Nox* — Latin for *night*.

[![CI](https://github.com/francescoa27122/nox-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/francescoa27122/nox-editor/actions/workflows/ci.yml)

[Try it](#try-it) · [What makes it different](#what-makes-it-different) · [Under the hood](#under-the-hood)

</div>

<!-- SCREENSHOT: hero -->
![Nox editing its own source](docs/screenshots/editor.png)

---

Nox is a text editor built around one idea: the editor should feel like a
command center, not a document viewer. Dark, quiet, keyboard-driven, and quick
enough that you stop noticing it.

It is **not** a VS Code clone. It has its own design language, its own
shortcuts where they can be better, and a deliberately small surface area. It
is also about 4 MB, and starts instantly.

I built it because I wanted to know what an editor looks like if you take two
things seriously from the first line of code: **never losing someone's work**,
and **letting a program help you edit without ever letting it edit behind your
back.**

## Try it

**Download it** from the [latest release](https://github.com/francescoa27122/nox-editor/releases/latest).

On macOS, drag Nox to Applications and run this once:

```bash
xattr -dr com.apple.quarantine /Applications/Nox.app
```

You will need that command. Nox is ad-hoc signed rather than signed with an
Apple Developer ID, so macOS quarantines it on download and claims it is
*"damaged"* — which sounds like a corrupt download but isn't.

### Or build it

If there's no build for your platform, or you'd rather not run that command,
build from source — it's the same thing from code you can read. You need
[Node 20+](https://nodejs.org), [Rust](https://rustup.rs), and your
platform's [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/francescoa27122/nox-editor.git
cd nox-editor
npm install
npm run app
```

The first run compiles the Rust side and takes a few minutes. After that it
starts in seconds.

**Just want a look?** `npm run dev` opens Nox in your browser against a small
demo project — no Rust build, nothing touches your disk.

## What makes it different

### It does not lose your work. Ever.

Close the window with unsaved changes and Nox does not ask you a question. It
just keeps them, and hands them back next time you open it — still unsaved,
still undoable back to what is on disk.

A dialog can be answered wrong at 2am. Persistence cannot.

Saving writes to a temporary file and renames it into place, so a crash or a
full disk mid-save can't leave you with half a file. If something else changes
a file while you have it open, Nox notices and tells you rather than quietly
picking a winner.

### Undo works across files

Run a project-wide find-and-replace across forty files and press <kbd>⌘Z</kbd>
**once**. The whole thing goes back, and Nox tells you what it undid. A file
you've edited since is left alone and reported, not silently reverted with the
rest.

That works because every programmatic edit is a transaction with an author,
applied to all of its files or none of them.

### Agents propose. You decide.

<!-- SCREENSHOT: review -->
![Reviewing a change an agent proposed](docs/screenshots/review.png)

Nox can run an AI agent — but it can't touch your files. An agent reads your
code through a read-only API and hands back a *proposal*. You get a diff, hunk
by hunk, and keep the parts you want. Nothing is written until you say so, and
one button takes a whole session back.

Everything it read, everything it ran, and everything it was refused is on the
record in the Agents panel.

**A model that runs on your machine.** Point Nox at an
[Ollama](https://ollama.com) server in `agents.json` and that is the whole
setup — no account, no API key, no telemetry. The HTTP client is loopback-only
and refuses anything that isn't, enforced in Rust rather than in the part of
the app a web page could reach.

**It reads and proposes. It cannot run commands.** Not a setting you left off
— the ability is not in the agent's vocabulary yet.

**Edits are quoted, not positional.** The model names the text it wants
replaced and Nox finds it, refusing anything ambiguous rather than guessing.
That exists because a 7B model gets the intent right and the arithmetic wrong:
handed raw character offsets it produced a zero-width insertion of an entire
function body — which the review panel would have rendered as a perfectly
convincing corrupt diff. And if you type in the file while the model is
thinking, the proposal is refused rather than landing at offsets that have
moved.

**Or bring your own.** An agent is any program that speaks a small JSON
protocol over stdin and stdout — there's a
[140-line example](examples/uppercase-agent.mjs) you can copy.

**Edit Selection with a Model…** Select some text, describe the change in your
own words, and skip the whole-workspace session for a two-line fix. The
selection reaches the model as part of the brief, and the answer comes back
through the same review panel. Hunks outside what you selected are still
proposed — never refused — but start unchecked and labelled *outside your
selection*, because a companion edit elsewhere in the file is often the right
one and this only changes which box starts ticked. Expect a partial result:
asked to do two things at once, a local model will often do one and stop, so
read the diff rather than assume the rest happened.

**Ask About Selection…** Select some code and ask what it does, in your own
words — or run **Explain Selection** and skip typing the question at all. The
answer arrives as prose in a new **Answers** section in the sidebar
(<kbd>Mod ⇧ A</kbd>), because there is no diff to review when nothing is being
changed.

An answer records which file and lines it was about, and says so when that code
has changed since, or when you have closed the file. Those are different
states and Nox does not collapse them: an explanation of code that has moved on
is worse than no explanation, and it should say which kind of wrong it might
be. Answers live for the session and are written nowhere, for the same reason.

**Asking cannot change anything.** Such a session may narrate and it may
summarise. Every other verb is refused in the runtime rather than discouraged
in the prompt, so the rule holds for an agent in another process that never
reads the prompt at all.

The section stays hidden until you configure an agent that can run. One
measured caveat: asked to explain some code *and* say what was surprising about
it, the local model summarised the code and ignored the second half of the
question.

**If you never turn any of this on, Nox is not a worse editor for it.** That was
the rule the whole time.

#### Where this goes next

The groundwork is the part that's done: authored transactions, a permission
model, a context API, staged change sets and a job runner all shipped before
any model did, and each one is an editor improvement on its own. What they
unlock, in roughly this order:

- **Workspace-aware chat**, with the context set shown and editable instead of
  guessed at behind your back. Asking about a selection covers the one-question
  case; a thread that remembers what you asked before is a different feature
  and wants its own argument.
- **Remote models** alongside the local one. A deliberate widening with its own
  argument to make — not something that falls out of the loopback rule.
- **Running commands**, gated by the permission model that already exists for
  it. Deliberately last: the first thing an unproven model integration does
  should not be taking real actions.

**The principle doesn't move:** AI is a panel and a set of commands, not a
rewrite of the editor. A feature that makes Nox worse for someone who never
turns it on does not ship.

### Dark only, on purpose

Two dark themes: **Eclipse**, a blue-black night, and **Umbra**, true black for
OLED. There is no light theme and there isn't going to be — that's the product,
not an omission.

Every colour, radius and duration comes from one token file. Umbra is a
30-line override of Eclipse, which is the proof the design system is real.

## The basics

`Mod` is <kbd>⌘</kbd> on macOS, <kbd>Ctrl</kbd> elsewhere.

| | |
|---|---|
| <kbd>Mod ⇧ P</kbd> | Everything. The command palette. |
| <kbd>Mod P</kbd> | Jump to a file |
| <kbd>Mod E</kbd> | Switch between open files |
| <kbd>Mod ⇧ F</kbd> | Search the whole project |
| <kbd>Mod \\</kbd> | Split the editor |
| <kbd>Mod ,</kbd> | Settings |

Press <kbd>Mod ⌥ K</kbd> for the full list — it's in the app, and it's always
current. Every action is a command, so anything you can do is in the palette
whether or not it has a shortcut.

Also in the box: syntax highlighting for nine language families, multiple
cursors, code folding, split panes, project-wide search and replace with a
reviewable diff, and a settings panel generated from a schema so it can never
drift from what's actually configurable.

## Status

**v0.2.** It's young, and it's a personal project rather than a product — but
it's real software with 759 tests and I use it. Expect rough edges; open an
issue if you hit one.

**Local models and asking about a selection both landed after v0.2 was
tagged**, so they are on `main` and in the next release rather than in the
download above. Build from source if you want them now.

Not there yet: no LSP, no Git integration, no plugins. Those are next, in
roughly that order — see [ROADMAP.md](ROADMAP.md).

## Under the hood

For anyone who wants the deep version:

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it's built, and the design decisions with their tradeoffs |
| [AGENT-PLATFORM.md](AGENT-PLATFORM.md) | The agent layer in full: transactions, permissions, review |
| [DESIGN.md](DESIGN.md) | The visual system and its rules |
| [ROADMAP.md](ROADMAP.md) | What's next, and what's deliberately not planned |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Where things go and why |

Built with [Tauri](https://tauri.app), [Svelte](https://svelte.dev) and
[CodeMirror 6](https://codemirror.net). The Rust side owns the window, the
filesystem and project search; the editor lives in the renderer.

```bash
npm test          # 759 unit tests
npm run check     # TypeScript + Svelte
npm run app:build # a distributable, ~4 MB on macOS
```

## License

[MIT](LICENSE) — do what you like with it.
