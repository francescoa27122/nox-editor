import { afterEach, describe, expect, it } from 'vitest';
import { mergeTasks, parseTasks, taskCommandLine, taskFingerprint, TASKS_EXAMPLE } from '../src/core/tasks';
import { MemoryPlatform } from '../src/platform/memory';
import type { AgentProcess, AgentProcessSpec, PlatformCapabilities } from '../src/platform/types';
import { JobRunner } from '../src/services/jobs';
import { MAX_OUTPUT_LINES, TASKS_FILE, TaskService } from '../src/services/tasks';
import { UIService } from '../src/services/ui';

/**
 * Running the project's own commands.
 *
 * The suite is organised around the one thing this feature has that the other
 * config readers do not: a `.nox/tasks.json` **arrives with a cloned
 * repository**, so the interesting assertions are not about parsing but about
 * what does and does not run without being asked for.
 *
 * The load-bearing test is "editing what a confirmed task runs asks again". It
 * is the one that fails if trust is ever keyed on a task's *name* rather than
 * its argv, which is the obvious implementation and the wrong one: a
 * repository would earn a yes for `test` meaning `npm test`, then change the
 * file behind a pull or a branch switch and inherit the approval.
 *
 * Mutation-checked on 2026-08-30. Keying `#approve` on `task.id` instead of
 * `taskFingerprint(task)` leaves every other test in this file green and fails
 * only that one.
 *
 * What it does not catch: nothing here observes a real process. `FakeProcess`
 * delivers whatever it is told to, in order, so the tests hold this service's
 * behaviour and not the Rust spawn beneath it. The line splitting, the stderr
 * drain and the exit code are `agent.rs`'s, tested there.
 */

/**
 * A process that says what it is told to and then exits.
 *
 * **It buffers**, because `AgentProcess` requires it to: "anything produced
 * before a handler is attached must be buffered and delivered when one is"
 * (`platform/types.ts:129-137`), since a real child can write in the same tick
 * it starts. A fake that dropped those lines would be a *more convenient*
 * shape than the real one, and would let a service that subscribes a moment
 * late pass this whole suite. Written down because the first version of this
 * class did drop them, and the test that caught it was the cancel one below.
 */
class FakeProcess implements AgentProcess {
  #line: ((line: string) => void) | null = null;
  #stderr: ((line: string) => void) | null = null;
  #exit: ((code: number | null) => void) | null = null;
  #pending: { text: string; stream: 'stdout' | 'stderr' }[] = [];
  #exited: { code: number | null } | null = null;
  killed = false;

  async send(): Promise<void> {}

  onLine(handler: (line: string) => void): void {
    this.#line = handler;
    this.#drain();
  }
  onStderr(handler: (line: string) => void): void {
    this.#stderr = handler;
    this.#drain();
  }
  onExit(handler: (code: number | null) => void): void {
    this.#exit = handler;
    // Fires immediately if it already has, which the interface also requires.
    if (this.#exited) handler(this.#exited.code);
  }
  async kill(): Promise<void> {
    this.killed = true;
    this.end(null);
  }

  say(text: string): void {
    this.#emit(text, 'stdout');
  }
  complain(text: string): void {
    this.#emit(text, 'stderr');
  }
  end(code: number | null): void {
    if (this.#exited) return;
    this.#exited = { code };
    this.#exit?.(code);
  }

  #emit(text: string, stream: 'stdout' | 'stderr'): void {
    this.#pending.push({ text, stream });
    this.#drain();
  }

  /**
   * Deliver only while *both* handlers are attached.
   *
   * Otherwise a stdout line delivered between the two `onLine`/`onStderr`
   * calls would overtake a stderr line that arrived before it, and the
   * interleaving test would be asserting the order this fake happened to
   * choose rather than the order the process produced.
   */
  #drain(): void {
    if (!this.#line || !this.#stderr) return;
    for (const entry of this.#pending.splice(0)) {
      if (entry.stream === 'stdout') this.#line(entry.text);
      else this.#stderr(entry.text);
    }
  }
}

/** A platform that can spawn, and hands back a process the test drives. */
class SpawningPlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    ...new MemoryPlatform().capabilities,
    agentProcesses: true,
  };

  readonly spawned: AgentProcessSpec[] = [];
  readonly processes: FakeProcess[] = [];
  /** Set by `hold()`, so a test can cancel while a spawn is in flight. */
  #gate: Promise<void> | null = null;

  override async spawnAgent(spec: AgentProcessSpec): Promise<AgentProcess> {
    this.spawned.push(spec);
    if (this.#gate) await this.#gate;
    const process = new FakeProcess();
    this.processes.push(process);
    return process;
  }

  /** Make the next spawn block until the returned function is called. */
  hold(): () => void {
    let release = (): void => {};
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.#gate = null;
      release();
    };
  }
}

interface Harness {
  platform: SpawningPlatform;
  ui: UIService;
  tasks: TaskService;
}

/**
 * The nth spawned process, once it exists.
 *
 * Polled rather than reached for after a fixed number of `await`s: how many
 * microtask turns a spawn takes is an implementation detail of `TaskService`
 * and the job runner, and a test that encodes it is a test that breaks when
 * either grows an await. Bounded so a genuine hang fails as a timeout rather
 * than spinning.
 */
async function nthProcess(platform: SpawningPlatform, index: number): Promise<FakeProcess> {
  for (let turn = 0; turn < 1000; turn += 1) {
    const process = platform.processes[index];
    if (process) return process;
    await Promise.resolve();
  }
  throw new Error(`no process ${index} was spawned`);
}

/** Answer the next confirmation with this choice. Null dismisses it. */
function answerWith(ui: UIService, choice: string | null): void {
  ui.confirm.subscribe((request) => {
    if (request) queueMicrotask(() => request.resolve(choice));
  });
}

async function harness(files: { user?: string; project?: string } = {}): Promise<Harness> {
  const platform = new SpawningPlatform();
  if (files.user !== undefined) await platform.writeConfigFile(TASKS_FILE, files.user);
  if (files.project !== undefined) {
    platform.seedFile('/proj/.nox/tasks.json', files.project);
  }
  const ui = new UIService();
  const tasks = new TaskService(platform, new JobRunner(), ui);
  await tasks.load(files.project === undefined ? null : '/proj');
  return { platform, ui, tasks };
}

const ONE = (id: string, command: string, args: string[] = []) =>
  JSON.stringify({ tasks: [{ id, command, args }] });

let harnesses: Harness[] = [];
afterEach(() => {
  harnesses = [];
});

describe('reading tasks.json', () => {
  it('drops a malformed entry and keeps the rest', () => {
    const { tasks, problems } = parseTasks(
      {
        tasks: [
          { id: 'ok', command: 'npm', args: ['test'] },
          { id: 'no-command' },
          { command: 'npm' },
          { id: 'bad args', command: 'npm' },
          { id: 'args', command: 'npm', args: ['run', 7] },
        ],
      },
      'user',
    );

    expect(tasks.map((task) => task.id)).toEqual(['ok']);
    expect(problems).toHaveLength(4);
  });

  it('refuses a whole task rather than dropping one argument', () => {
    // The lenient reading would filter the number out and leave `npm run`,
    // which is a *different command* that still looks runnable, and the
    // confirmation would then show a line the author never wrote.
    const { tasks, problems } = parseTasks(
      { tasks: [{ id: 'a', command: 'npm', args: ['run', 7, 'build'] }] },
      'project',
    );
    expect(tasks).toEqual([]);
    expect(problems[0]).toContain('not a string');
  });

  it('falls back to the id when no label is given', () => {
    const { tasks } = parseTasks({ tasks: [{ id: 'test', command: 'npm' }] }, 'user');
    expect(tasks[0]?.label).toBe('test');
  });

  it('parses its own example with nothing to report', () => {
    // An example that warns on first open teaches the reader that warnings
    // here are normal.
    const { tasks, problems } = parseTasks(JSON.parse(TASKS_EXAMPLE), 'user');
    expect(problems).toEqual([]);
    expect(tasks).toHaveLength(2);
  });

  it('keeps the first of two tasks sharing an id', () => {
    const { tasks, problems } = parseTasks(
      {
        tasks: [
          { id: 'test', command: 'first' },
          { id: 'test', command: 'second' },
        ],
      },
      'user',
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.command).toBe('first');
    expect(problems[0]).toContain('twice');
  });
});

describe('the argv fingerprint', () => {
  it('separates on a byte an argument cannot contain', () => {
    // A space would let these two collide, and they are different commands.
    expect(taskFingerprint({ command: 'x', args: ['a b'] }, null)).not.toBe(
      taskFingerprint({ command: 'x', args: ['a', 'b'] }, null),
    );
  });

  it('is different in a different folder, for the same argv', () => {
    // What `npm test` *does* is decided by the package.json beside it, so the
    // argv alone is not the thing being approved.
    expect(taskFingerprint({ command: 'npm', args: ['test'] }, '/a')).not.toBe(
      taskFingerprint({ command: 'npm', args: ['test'] }, '/b'),
    );
  });

  it('refuses a NUL rather than letting it collide with the separator', () => {
    // The comment on `taskFingerprint` called the key collision-free "by
    // construction". That was a property of execve, not of this parser: JSON
    // carries a NUL happily, and these two produced the same key.
    expect(parseTasks({ tasks: [{ id: 'a', command: 'npm\u0000run' }] }, 'user').tasks).toEqual([]);
    expect(
      parseTasks({ tasks: [{ id: 'a', command: 'npm', args: ['run\u0000build'] }] }, 'user').tasks,
    ).toEqual([]);
  });

  it('quotes an argument that would otherwise read as two', () => {
    // Presentation only, and never parsed back. It exists so the one dialog
    // whose job is showing what will run cannot show two arguments as one.
    expect(taskCommandLine({ command: 'git', args: ['commit', '-m', 'a b'] })).toBe(
      'git commit -m "a b"',
    );
  });

  it('does not render two different argvs as the same line', () => {
    // The denylist this replaced tested JavaScript's `\s`, which does not
    // include U+200B. So `["test"]` and `["test\u200b"]` both rendered as
    // `npm test` while keying differently: the dialog would open a second time
    // showing text indistinguishable from the text already approved, which is
    // how a person is taught to click Run without reading.
    const plain = taskCommandLine({ command: 'npm', args: ['test'] });
    const sneaky = taskCommandLine({ command: 'npm', args: ['test\u200b'] });
    expect(plain).not.toBe(sneaky);

    // Same for a bidi override, which reorders what is drawn.
    expect(taskCommandLine({ command: 'npm', args: ['\u202etest'] })).not.toBe(plain);
  });
});

describe('two sources', () => {
  it('lets a user task shadow a project task, and says which', () => {
    const user = parseTasks(ONE_OBJ('test', 'mine'), 'user').tasks;
    const project = parseTasks(ONE_OBJ('test', 'theirs'), 'project').tasks;
    const merged = mergeTasks(user, project);

    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0]?.command).toBe('mine');
    // Reported rather than dropped: a repository must not be able to take the
    // name of a task you trusted and have you find out by its silence.
    expect(merged.shadowed.map((task) => task.id)).toEqual(['test']);
  });
});

function ONE_OBJ(id: string, command: string): unknown {
  return { tasks: [{ id, command }] };
}

describe('running', () => {
  it('never asks about a task from your own file', async () => {
    const h = await harness({ user: ONE('test', 'npm', ['test']) });
    harnesses.push(h);
    let asked = false;
    h.ui.confirm.subscribe((request) => {
      if (request) asked = true;
    });

    const run = h.tasks.run('test');
    (await nthProcess(h.platform, 0)).end(0);
    await run;

    expect(asked).toBe(false);
    expect(h.platform.spawned[0]?.command).toBe('npm');
  });

  it('does not run a project task until it is confirmed', async () => {
    const h = await harness({ project: ONE('test', 'npm', ['test']) });
    harnesses.push(h);
    answerWith(h.ui, 'cancel');

    expect(await h.tasks.run('test')).toBeNull();
    expect(h.platform.spawned).toEqual([]);
  });

  it('asks again when the project changes what a confirmed task runs', async () => {
    // The one that matters. Trust is keyed on the argv, so this is a new
    // question rather than an inherited yes. Keying it on `task.id` instead
    // leaves every other test here green and fails this one.
    const h = await harness({ project: ONE('test', 'npm', ['test']) });
    harnesses.push(h);

    let asks = 0;
    h.ui.confirm.subscribe((request) => {
      if (!request) return;
      asks += 1;
      queueMicrotask(() => request.resolve('run'));
    });

    const first = h.tasks.run('test');
    (await nthProcess(h.platform, 0)).end(0);
    await first;
    expect(asks).toBe(1);

    // Same run again: already trusted, so no second question.
    const again = h.tasks.run('test');
    (await nthProcess(h.platform, 1)).end(0);
    await again;
    expect(asks).toBe(1);

    // The repository edits the file behind a pull. Same id, different argv.
    h.platform.seedFile('/proj/.nox/tasks.json', ONE('test', 'curl', ['evil.example']));
    await h.tasks.load('/proj');

    const third = h.tasks.run('test');
    (await nthProcess(h.platform, 2)).end(0);
    await third;
    expect(asks).toBe(2);
  });

  it('asks again for the same argv in a different folder', async () => {
    // The hole a review found on 2026-08-30. `npm test` means whatever the
    // package.json beside it says, so an approval given in a repository you
    // trust must not carry into a stranger's clone opened in the same window.
    // Keying on the argv alone, this passes silently with no second dialog.
    const h = await harness({ project: ONE('test', 'npm', ['test']) });
    harnesses.push(h);

    let asks = 0;
    h.ui.confirm.subscribe((request) => {
      if (!request) return;
      asks += 1;
      queueMicrotask(() => request.resolve('run'));
    });

    const first = h.tasks.run('test');
    (await nthProcess(h.platform, 0)).end(0);
    await first;
    expect(asks).toBe(1);

    // A different repository, same task id, same argv.
    h.platform.seedFile('/other/.nox/tasks.json', ONE('test', 'npm', ['test']));
    await h.tasks.load('/other');

    const second = h.tasks.run('test');
    (await nthProcess(h.platform, 1)).end(0);
    await second;

    expect(asks).toBe(2);
    expect(h.platform.spawned[1]?.cwd).toBe('/other');
  });

  it('forgets approvals when asked, so the next run asks again', async () => {
    const h = await harness({ project: ONE('test', 'npm', ['test']) });
    harnesses.push(h);
    answerWith(h.ui, 'run');

    const first = h.tasks.run('test');
    (await nthProcess(h.platform, 0)).end(0);
    await first;
    expect(h.tasks.trusted.get().size).toBe(1);

    h.tasks.forgetTrust();
    expect(h.tasks.trusted.get().size).toBe(0);
  });

  it('runs in the workspace root and never in a directory the task named', async () => {
    // There is no `cwd` field to set. A task that could name its own
    // directory could name `/`.
    const h = await harness({
      project: JSON.stringify({ tasks: [{ id: 't', command: 'npm', cwd: '/elsewhere' }] }),
    });
    harnesses.push(h);
    answerWith(h.ui, 'run');

    const run = h.tasks.run('t');
    (await nthProcess(h.platform, 0)).end(0);
    await run;

    expect(h.platform.spawned[0]?.cwd).toBe('/proj');
  });

  it('interleaves stdout and stderr in arrival order', async () => {
    // Two lists would put a compiler's error somewhere other than the step it
    // belongs to.
    const h = await harness({ user: ONE('test', 'npm') });
    harnesses.push(h);

    const run = h.tasks.run('test');
    const process = await nthProcess(h.platform, 0);
    process.say('one');
    process.complain('two');
    process.say('three');
    process.end(0);
    const result = await run;

    expect(result?.output.map((line) => `${line.stream}:${line.text}`)).toEqual([
      'stdout:one',
      'stderr:two',
      'stdout:three',
    ]);
  });

  it('keeps the newest lines when a build outruns the cap', async () => {
    // Dropping the oldest, because the alternative throws away the end of the
    // build, which is where the error is.
    const h = await harness({ user: ONE('test', 'npm') });
    harnesses.push(h);

    const run = h.tasks.run('test');
    const process = await nthProcess(h.platform, 0);
    for (let index = 0; index < MAX_OUTPUT_LINES + 10; index += 1) process.say(`line ${index}`);
    process.end(0);
    const result = await run;

    expect(result?.output).toHaveLength(MAX_OUTPUT_LINES);
    expect(result?.output.at(-1)?.text).toBe(`line ${MAX_OUTPUT_LINES + 9}`);
    expect(result?.output[0]?.text).toBe('line 10');
  });

  it('reports the exit code', async () => {
    const h = await harness({ user: ONE('test', 'npm') });
    harnesses.push(h);

    const run = h.tasks.run('test');
    (await nthProcess(h.platform, 0)).end(2);
    const result = await run;

    expect(result?.status).toBe('exited');
    expect(result?.exitCode).toBe(2);
  });

  it('reports a command that could not be started', async () => {
    const h = await harness({ user: ONE('test', 'nope') });
    harnesses.push(h);
    h.platform.spawnAgent = async () => {
      throw new Error('no such file');
    };

    const result = await h.tasks.run('test');

    expect(result?.status).toBe('failed');
    expect(result?.error).toContain('no such file');
  });
});

describe('stopping', () => {
  it('kills the process and keeps what it had already printed', async () => {
    const h = await harness({ user: ONE('test', 'npm') });
    harnesses.push(h);

    const run = h.tasks.run('test');
    const process = await nthProcess(h.platform, 0);
    process.say('half a build');
    h.tasks.stop();
    const result = await run;

    expect(process.killed).toBe(true);
    expect(result?.status).toBe('cancelled');
    // Cancelled is not failed, and the output up to the stop is the useful
    // part of a run someone stopped.
    expect(result?.output.map((line) => line.text)).toEqual(['half a build']);
  });

  it('stops both when two tasks are running at once', async () => {
    // Nothing serialises runs: `tasks.run` is not disabled while one is going,
    // so a second can start from the palette beside the first. With `running`
    // as a single id it named only the most recent, and this test fails with
    // the earlier process still alive and nothing in the UI able to reach it.
    const h = await harness({
      user: JSON.stringify({
        tasks: [
          { id: 'slow', command: 'sleep' },
          { id: 'quick', command: 'npm' },
        ],
      }),
    });
    harnesses.push(h);

    const slow = h.tasks.run('slow');
    await nthProcess(h.platform, 0);
    const quick = h.tasks.run('quick');
    await nthProcess(h.platform, 1);
    expect(h.tasks.running.get().size).toBe(2);

    h.tasks.stop();
    await Promise.all([slow, quick]);

    expect(h.platform.processes.map((process) => process.killed)).toEqual([true, true]);
    expect(h.tasks.running.get().size).toBe(0);
  });

  it('kills a process that was still being spawned when it was cancelled', async () => {
    // The window `JobContext.onCancel` closes by firing immediately when
    // cancellation already happened. Without it the handler runs with nothing
    // to kill and the process outlives the job that owns it.
    const h = await harness({ user: ONE('test', 'npm') });
    harnesses.push(h);
    const resume = h.platform.hold();

    const run = h.tasks.run('test');
    await Promise.resolve();
    h.tasks.stop();
    resume();
    await run;

    expect(h.platform.processes[0]?.killed).toBe(true);
  });
});

describe('availability', () => {
  it('does not run where nothing can be spawned', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(TASKS_FILE, ONE('test', 'npm'));
    const tasks = new TaskService(platform, new JobRunner(), new UIService());
    await tasks.load(null);

    expect(tasks.available).toBe(false);
    // `MemoryPlatform.spawnAgent` throws rather than pretending, so this is
    // the gate doing its job rather than a silent no-op.
    expect(await tasks.run('test')).toBeNull();
  });
});
