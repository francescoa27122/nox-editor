import { Signal } from '@core/signal';
import type { Capability, Principal } from './permissions';

/**
 * The command registry.
 *
 * Nox's central rule: *every* user-visible action is a command. Menus, the
 * palette, keybindings and buttons all dispatch the same id. The payoff is
 * that the command palette and keybinding customisation are complete for free
 * — permanently — instead of needing a second pass every time a feature lands.
 *
 * It is also the *only* place permissions are enforced. Because every action
 * is already a command, one check here covers everything a plugin or an agent
 * could ask for — and there is no second path to forget about.
 */

export interface Command {
  id: string;
  title: string;
  /** Grouping shown before the title in the palette, e.g. "File". */
  category?: string;
  /** Extra terms the palette will match against. */
  keywords?: readonly string[];
  /**
   * Chord to display when the binding is owned by CodeMirror rather than the
   * application keymap. Without this the palette would claim that Undo has no
   * shortcut. Written in `Mod+Z` form and formatted for the platform.
   */
  keyHint?: string;
  /** Enablement. A disabled command is greyed in the palette and unbindable. */
  enabled?: () => boolean;
  /** Hide from the palette. Still executable and bindable. */
  hidden?: boolean;
  /**
   * What this command needs permission to do.
   *
   * Absent means "nothing with a side effect" — moving the cursor, opening a
   * panel. A command that writes, deletes, shells out or reaches the network
   * must say so, because this declaration is the whole basis of enforcement.
   */
  capabilities?: readonly Capability[];
  /**
   * The thing being acted on, so a grant can be scoped to it.
   *
   * The dispatcher cannot know which file `file.save` is about to write, but
   * the command can. Returning undefined falls back to a capability-level
   * check, which is correct for commands with no single subject.
   */
  resourceFrom?: (arg?: unknown) => string | undefined;
  /**
   * The return value is always ignored — `unknown` rather than `void` because
   * many handlers usefully forward a result (CodeMirror commands return a
   * boolean for "did you handle it"), and forcing every one of those through a
   * wrapper block would be noise.
   */
  run: (arg?: unknown) => unknown;
}

export interface ResolvedCommand extends Command {
  /** Display form of the first keybinding, if any. Filled by KeymapService. */
  keybinding?: string;
}

/**
 * Consulted before a command runs on someone else's behalf. Throws to refuse.
 *
 * A function rather than a service dependency: the registry stays free of any
 * knowledge of the permission model, and a test can install its own.
 */
export type CommandGuard = (
  command: Command,
  principal: Principal,
  resource: string | undefined,
) => Promise<void>;

/**
 * Told about a command whose `run` threw, before the error is rethrown.
 *
 * One sink for every command there will ever be, for the same reason there is
 * one guard: almost every call site dispatches with `void`, and the release
 * webview has no devtools, so a `console.error` is a failure that produced no
 * user-visible artefact at all. Notifying is the app's job, not the registry's
 * — hence a function, like {@link CommandGuard}.
 */
export type CommandFailureSink = (command: Command, error: unknown) => void;

/** How many recently-executed command ids `recentCommands` keeps. */
const RECENT_LIMIT = 8;

export class CommandRegistry {
  #commands = new Map<string, Command>();
  #guard: CommandGuard | null = null;
  #failureSink: CommandFailureSink | null = null;
  /** Bumped whenever the set of commands changes, so the palette can react. */
  readonly version = new Signal(0);
  readonly lastExecuted = new Signal<string | null>(null);
  /**
   * Recently executed command ids, most recent first, deduplicated, capped at
   * {@link RECENT_LIMIT}. Session-scoped on purpose — like the buffer
   * switcher's recency, it is not persisted across restarts. A plain array
   * rather than a signal: the palette remounts on every opening and executing
   * a command closes it, so there is no open view to invalidate.
   */
  #recent: string[] = [];

  register(command: Command): () => void {
    if (this.#commands.has(command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`);
    }
    this.#commands.set(command.id, command);
    this.version.update((n) => n + 1);
    return () => {
      this.#commands.delete(command.id);
      this.version.update((n) => n + 1);
    };
  }

  registerAll(commands: readonly Command[]): () => void {
    const disposers = commands.map((c) => this.register(c));
    return () => disposers.forEach((d) => d());
  }

  get(id: string): Command | undefined {
    return this.#commands.get(id);
  }

  has(id: string): boolean {
    return this.#commands.has(id);
  }

  /** All commands, including hidden and disabled ones. */
  all(): Command[] {
    return [...this.#commands.values()];
  }

  /** Commands eligible for the palette, in registration order. */
  palette(): Command[] {
    return this.all().filter((c) => !c.hidden);
  }

  /** Recently executed command ids, most recent first. See {@link #recent}. */
  recentCommands(): readonly string[] {
    return this.#recent;
  }

  isEnabled(id: string): boolean {
    const command = this.#commands.get(id);
    if (!command) return false;
    return command.enabled ? command.enabled() : true;
  }

  /** Install the permission check. One guard, one call site. */
  setGuard(guard: CommandGuard | null): void {
    this.#guard = guard;
  }

  /** Install the failure reporter. One sink, one call site. */
  setFailureSink(sink: CommandFailureSink | null): void {
    this.#failureSink = sink;
  }

  /**
   * Execute a command. Returns false when the command is unknown or disabled,
   * which the keymap uses to decide whether to swallow the key event.
   *
   * `principal` names who is asking. It defaults to the user, so every
   * existing call site — menus, keybindings, buttons — keeps working and keeps
   * bypassing the guard, which is the intended behaviour rather than an
   * oversight: see `PermissionService.check`.
   *
   * Throws `PermissionError` when a programmatic caller is refused. A denial
   * that returned false would be indistinguishable from a disabled command,
   * and "nothing happened" is the worst possible answer to "may I".
   */
  async execute(
    id: string,
    arg?: unknown,
    options: { principal?: Principal } = {},
  ): Promise<boolean> {
    const command = this.#commands.get(id);
    if (!command) {
      console.warn(`[nox] unknown command: ${id}`);
      return false;
    }
    if (command.enabled && !command.enabled()) return false;

    const principal = options.principal;
    if (this.#guard && principal && principal.kind !== 'user' && command.capabilities?.length) {
      await this.#guard(command, principal, command.resourceFrom?.(arg));
    }

    this.lastExecuted.set(id);
    this.#recent = [id, ...this.#recent.filter((r) => r !== id)].slice(0, RECENT_LIMIT);
    try {
      await command.run(arg);
    } catch (error) {
      // Rethrow shape is normalised by callers; never let it kill the app.
      console.error(`[nox] command "${id}" failed:`, error);
      // Before the rethrow, so the sink runs even for the ~40 call sites that
      // discard the promise with `void` and would otherwise report nothing.
      this.#failureSink?.(command, error);
      throw error;
    }
    return true;
  }
}
