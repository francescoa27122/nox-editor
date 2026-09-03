import { join } from '@core/path';
import { Signal } from '@core/signal';
import {
  mergeTasks,
  parseTasks,
  TASKS_EXAMPLE,
  taskCommandLine,
  taskFingerprint,
  type Task,
} from '@core/tasks';
import type { AgentProcess, Platform } from '@platform/types';
import type { JobRunner } from './jobs';
import type { UIService } from './ui';

/**
 * Running the project's own commands, and keeping what they print.
 *
 * Two files, one shape, and the difference between them is the whole feature:
 * `<config>/tasks.json` is the user's and runs on sight, `<root>/.nox/tasks.json`
 * arrives with a cloned repository and does not run until the user has been
 * shown the exact argv and said yes.
 *
 * See `docs/superpowers/specs/2026-08-30-tasks-design.md`. §0 is the argument
 * for why the second file needs a gate that `.nox/settings.json` solved by
 * refusing the whole class of key, and §1 is why that gate is here rather than
 * in `PermissionService`: the permission model exempts the user principal on
 * purpose, and the question here is not what an agent may make Nox do but
 * whether the thing Nox is about to run is the user's at all.
 */

export const TASKS_FILE = 'tasks.json';
const WORKSPACE_TASKS_PATH = '.nox/tasks.json';

/**
 * How much of a run's output is kept, per task.
 *
 * A constant rather than a setting, for the reason `MAX_BLAME_BYTES` is one:
 * it is a bound that keeps the renderer honest rather than a preference
 * anybody holds an opinion about. Dropping the *oldest* is what the ring does,
 * because the alternative throws away the end of the build, which is where the
 * error is.
 */
export const MAX_OUTPUT_LINES = 5_000;

/**
 * How often the output signal is allowed to fire while a task is talking.
 *
 * A build prints faster than anyone reads, and without this each line was a
 * signal emit and a re-render of every row on screen: `npm test` alone is a
 * few thousand. Coalescing bounds that to 20 repaints a second no matter how
 * loud the process is, which is the same trade the git gutter makes with its
 * 300 ms recompute. Rule 5 is about the typing path and this is not on it, but
 * a process can outrun a human just as easily as a keyboard can.
 */
const OUTPUT_FLUSH_MS = 50;

/** One line a task printed, and which stream it came from. */
export interface OutputLine {
  text: string;
  stream: 'stdout' | 'stderr';
}

export type TaskRunStatus = 'running' | 'exited' | 'failed' | 'cancelled';

/** A finished or running invocation of one task. */
export interface TaskRun {
  taskId: string;
  label: string;
  /** What was actually executed, as the confirmation showed it. */
  commandLine: string;
  status: TaskRunStatus;
  /** Null while running, and for a run that never got as far as a process. */
  exitCode: number | null;
  output: readonly OutputLine[];
  /** Set when the process could not be started at all. */
  error: string | null;
}

/**
 * Where a project keeps its `tasks.json`.
 *
 * Through `join`, never a template with a literal `/`, for the reason
 * `workspaceConfigPath` records at `config/index.ts:305`: the hardcoded
 * separator produces a path that is real to the OS and a different *string*
 * from the one the watcher reports, and every comparison downstream is a
 * string compare.
 */
export function workspaceTasksPath(root: string): string {
  return join(root, ...WORKSPACE_TASKS_PATH.split('/'));
}

/** A file's contents, or the sentence saying why there are none. */
type ReadResult = { ok: true; value: unknown } | { ok: false; problem: string | null };

export class TaskService {
  /** Everything runnable: the user's, then the project's it does not shadow. */
  readonly tasks = new Signal<readonly Task[]>([]);
  /**
   * Project tasks suppressed by a user task of the same id.
   *
   * Kept and shown rather than dropped: a repository must not be able to take
   * over the name of a task you already trusted, and learning that it tried by
   * watching your own task quietly stop running is the worst version of it.
   */
  readonly shadowed = new Signal<readonly Task[]>([]);
  /** Whatever either file could not be read, joined. Null when both are clean. */
  readonly error = new Signal<string | null>(null);
  /** The most recent run of each task, keyed by task id. */
  readonly runs = new Signal<ReadonlyMap<string, TaskRun>>(new Map());
  /**
   * The tasks running right now.
   *
   * A set rather than one id, because nothing serialises runs: `tasks.run`
   * from the palette is not disabled while something is going, so a second
   * task can start beside the first. A single field would then name only the
   * most recent, and `stop` would leave the earlier one running with nothing
   * in the UI able to reach it.
   */
  readonly running = new Signal<ReadonlySet<string>>(new Set());
  /** The last task asked for, so `tasks.runLast` has something to repeat. */
  readonly lastTaskId = new Signal<string | null>(null);
  /**
   * The argv fingerprints the user has approved this session.
   *
   * Public and readonly so the panel can list them, because a grant you
   * cannot see is a grant you cannot withdraw (`AGENT-PLATFORM.md:275`).
   * In memory only: see spec §4 for why this does not reach disk.
   */
  readonly trusted = new Signal<ReadonlySet<string>>(new Set());

  #platform: Platform;
  #jobs: JobRunner;
  #ui: UIService;
  #root: string | null = null;
  #flush: ReturnType<typeof setTimeout> | null = null;

  constructor(platform: Platform, jobs: JobRunner, ui: UIService) {
    this.#platform = platform;
    this.#jobs = jobs;
    this.#ui = ui;
  }

  /**
   * Whether this build can start a process at all.
   *
   * Reads the flag `spawnAgent` is gated on rather than one of its own,
   * because it is the same question: the browser target has no way to run a
   * child, and `MemoryPlatform.spawnAgent` throws `unsupported` rather than
   * pretending. The flag's name is narrower than what it now gates, which is
   * recorded in the Known debt table rather than fixed by renaming a shipped
   * capability.
   */
  get available(): boolean {
    return this.#platform.capabilities.agentProcesses;
  }

  /** Read both files. Safe to call whenever either might have changed. */
  async load(root: string | null): Promise<void> {
    this.#root = root;
    const problems: string[] = [];

    const userFile = await this.#read(() => this.#platform.readConfigFile(TASKS_FILE));
    if (!userFile.ok && userFile.problem) problems.push(`tasks.json: ${userFile.problem}`);
    const user = parseTasks(userFile.ok ? userFile.value : {}, 'user');
    problems.push(...user.problems.map((problem) => `tasks.json: ${problem}`));

    let project: Task[] = [];
    if (root) {
      const file = await this.#read(() => this.#platform.readTextFile(workspaceTasksPath(root)));
      if (!file.ok && file.problem) problems.push(`.nox/tasks.json: ${file.problem}`);
      const parsed = parseTasks(file.ok ? file.value : {}, 'project');
      project = parsed.tasks;
      problems.push(...parsed.problems.map((problem) => `.nox/tasks.json: ${problem}`));
    }

    const merged = mergeTasks(user.tasks, project);
    this.tasks.set(merged.tasks);
    this.shadowed.set(merged.shadowed);
    this.error.set(problems.length > 0 ? problems.join('; ') : null);
  }

  /**
   * Whether running this task would put the confirmation dialog on screen.
   *
   * Here rather than in the panel, which computed the fingerprint itself until
   * a review on 2026-08-30. That was logic in a component (rule 1) and it went
   * wrong the moment the key gained the root: a component cannot see `#root`,
   * so it would have gone on answering the old question.
   */
  willAsk(task: Task): boolean {
    return task.source === 'project' && !this.trusted.get().has(taskFingerprint(task, this.#root));
  }

  byId(id: string): Task | null {
    return this.tasks.get().find((task) => task.id === id) ?? null;
  }

  /**
   * Run a task, asking first if the repository is the one that named it.
   *
   * Resolves once the process has ended, so a caller that wants to know can
   * await it. Returns null when nothing ran, which covers three cases the
   * caller does not need to tell apart: no such task, this build cannot spawn,
   * and the user said no.
   */
  async run(id: string): Promise<TaskRun | null> {
    const task = this.byId(id);
    if (!task) return null;
    if (!this.available) return null;
    if (!(await this.#approve(task))) return null;

    this.lastTaskId.set(task.id);
    const commandLine = taskCommandLine(task);
    const output: OutputLine[] = [];

    // Seeded before the job starts so the panel has a row to draw the moment
    // the user asks, rather than after the first line of output arrives.
    const seed: TaskRun = {
      taskId: task.id,
      label: task.label,
      commandLine,
      status: 'running',
      exitCode: null,
      output,
      error: null,
    };
    this.#setRun(seed);
    this.#markRunning(task.id, true);

    // Keyed on the task id, so asking for a task again supersedes the run
    // already going rather than racing it. That is `JobRunner`'s, not a
    // generation counter of this service's.
    const job = this.#jobs.run<number | null>(
      { title: `Task: ${task.label}`, key: `task:${task.id}`, cancellable: true },
      (context) => this.#spawn(task, output, context),
    );

    const outcome = await job.result;
    this.#markRunning(task.id, false);
    // Only once nothing is left to announce. A flush pending from another
    // task's output is still owed a repaint.
    if (this.running.get().size === 0) this.#cancelFlush();

    // Every ending keeps the output collected so far, because the part of a
    // run someone stopped that is worth anything is what it had already said.
    const ended: TaskRun =
      outcome.status === 'done'
        ? { ...seed, status: 'exited', exitCode: outcome.value, output: [...output] }
        : outcome.status === 'cancelled'
          ? { ...seed, status: 'cancelled', output: [...output] }
          : {
              ...seed,
              status: 'failed',
              output: [...output],
              error:
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            };
    this.#setRun(ended);
    return ended;
  }

  /**
   * Stop one running task, or every one of them when given no id. The job's
   * `onCancel` kills the process, including in the window before the spawn has
   * returned one.
   */
  stop(id?: string): void {
    const ids = id === undefined ? [...this.running.get()] : [id];
    for (const each of ids) this.#jobs.cancelActive(`task:${each}`);
  }

  /** Drop every approval given this session, so the next run asks again. */
  forgetTrust(): void {
    this.trusted.set(new Set());
  }

  /** Create the user's file with a working example if it does not exist yet. */
  async ensureFile(): Promise<void> {
    const existing = await this.#platform.readConfigFile(TASKS_FILE).catch(() => null);
    if (existing !== null && existing.trim().length > 0) return;
    await this.#platform.writeConfigFile(TASKS_FILE, TASKS_EXAMPLE);
  }

  /**
   * Whether this task may run, asking the user if the project named it.
   *
   * The user's own tasks never ask. They are not a threat model: that file is
   * in the user's configuration directory and nothing but the user's own tools
   * writes it, which is the standing `servers.json` and `agents.json` already
   * have.
   */
  async #approve(task: Task): Promise<boolean> {
    if (task.source === 'user') return true;

    // Keyed on the argv *and the root*, never the id. See `taskFingerprint`.
    const fingerprint = taskFingerprint(task, this.#root);
    if (this.trusted.get().has(fingerprint)) return true;

    const choice = await this.#ui.askToConfirm({
      title: 'Run a task from this project?',
      message:
        'This task is defined by the repository, not by you, in .nox/tasks.json.\n\n' +
        `${taskCommandLine(task)}\n\n` +
        // The folder is named rather than implied. It is half of what the user
        // is agreeing to: the argv means nothing without it, since what
        // `npm test` does is decided by the `package.json` in this directory.
        `It will run in ${this.#root ?? 'the workspace folder'} with your ` +
        'account\'s permissions.\n\n' +
        // Said out loud because it is true and the dialog was the only place a
        // person could learn it. "Run" is not one run.
        'Nox will not ask again for this exact command in this folder until you quit.',
      choices: [
        // Destructive first, safe last, which is the order the other eight
        // `askToConfirm` sites in the app use. This one had them reversed, so
        // the single dialog that authorises running a stranger's program put
        // Run where every other dialog puts Cancel.
        { id: 'run', label: 'Run', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      // Named rather than inferred: `run` is the danger choice, so leaving the
      // default to position or to `danger` alone would put Enter on it.
      defaultChoiceId: 'cancel',
    });
    if (choice !== 'run') return false;

    this.trusted.update((set) => new Set(set).add(fingerprint));
    return true;
  }

  /**
   * The job body: one process, its output appended to `output`, its exit code.
   *
   * `output` is the caller's array and is mutated in place. The signal carries
   * the same reference while a run is going, so a flush is a Map copy and a
   * repaint rather than a copy of everything printed so far, which at the
   * 5,000-line cap would have been quadratic in the length of the build.
   */
  async #spawn(
    task: Task,
    output: OutputLine[],
    context: { onCancel: (fn: () => void) => void },
  ): Promise<number | null> {
    let child: AgentProcess | null = null;
    let killed = false;

    // Registered before the spawn is awaited. `JobContext.onCancel` fires
    // immediately when cancellation already happened, which is what closes the
    // window between asking for a process and being handed the one to kill.
    context.onCancel(() => {
      killed = true;
      void child?.kill();
    });

    const push = (text: string, stream: OutputLine['stream']): void => {
      output.push({ text, stream });
      // Oldest out, so what survives is the end of the build.
      if (output.length > MAX_OUTPUT_LINES) output.splice(0, output.length - MAX_OUTPUT_LINES);
      this.#scheduleFlush();
    };

    child = await this.#platform.spawnAgent({
      command: task.command,
      args: [...task.args],
      // Never the task's own: a task that could name a directory could name
      // `/`. See spec §3.
      ...(this.#root ? { cwd: this.#root } : {}),
    });

    // Cancellation can land while the spawn above is in flight, and the
    // handler that ran then had nothing to kill yet.
    const process = child;
    if (killed) void process.kill();

    return await new Promise<number | null>((resolve) => {
      // stdout and stderr go into one list in arrival order rather than two,
      // because a compiler writes its errors to stderr and its progress to
      // stdout, and separating them puts the error somewhere other than the
      // step it belongs to. The tag is kept so the panel can dim one.
      process.onLine((line) => push(line, 'stdout'));
      process.onStderr((line) => push(line, 'stderr'));
      process.onExit(resolve);
    });
  }

  /** Announce appended output, at most every `OUTPUT_FLUSH_MS`. */
  #scheduleFlush(): void {
    if (this.#flush !== null) return;
    this.#flush = setTimeout(() => {
      this.#flush = null;
      this.runs.touch();
    }, OUTPUT_FLUSH_MS);
  }

  #cancelFlush(): void {
    if (this.#flush === null) return;
    clearTimeout(this.#flush);
    this.#flush = null;
  }

  #markRunning(id: string, running: boolean): void {
    this.running.update((ids) => {
      const next = new Set(ids);
      if (running) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  #setRun(run: TaskRun): void {
    this.runs.update((runs) => new Map(runs).set(run.taskId, run));
  }

  /** Read and parse one file, distinguishing absent from unreadable. */
  async #read(read: () => Promise<string | null>): Promise<ReadResult> {
    let raw: string | null;
    try {
      raw = await read();
    } catch {
      // Absent is the state everyone starts in, and is not a problem.
      return { ok: false, problem: null };
    }
    if (!raw || raw.trim().length === 0) return { ok: false, problem: null };
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (error) {
      // Said out loud rather than swallowed: a typo here looks exactly like
      // having defined no tasks, which is what the author was trying to stop
      // being true. One broken file never stops the other being read.
      return {
        ok: false,
        problem: error instanceof Error ? error.message : 'not valid JSON',
      };
    }
  }
}
