/**
 * `tasks.json`, as data.
 *
 * Pure. Reads one of these files into a list of tasks and a list of sentences
 * about what it could not read, and computes the fingerprint that a project
 * task's approval is keyed on.
 *
 * The leniency is `core/snippets.ts`'s rather than `core/plugin-manifest.ts`'s:
 * a malformed entry is dropped and named, so one typo cannot empty a working
 * file. That is the right trade here for the reason it is wrong there. A
 * plugin manifest's fields are an author's claim about what their code may do,
 * so trimming one leaves a declaration that no longer matches the behaviour.
 * A task grants nothing by existing. It is inert until someone asks for it by
 * name, and at that point §4 of the spec asks again anyway, so a dropped task
 * costs its author a missing row and costs the user nothing.
 *
 * See `docs/superpowers/specs/2026-08-30-tasks-design.md`.
 */

/** Which file a task came from, which is the whole basis of whether it prompts. */
export type TaskSource = 'user' | 'project';

/**
 * One task, after parsing.
 *
 * There is no `shell` field and no string form of `command` that gets split,
 * and there is no `cwd`. See spec §3: argv with no second reader is what makes
 * the confirmation dialog's text and the bytes handed to the OS the same
 * thing, and a task that could name its own directory could name `/`.
 */
export interface Task {
  id: string;
  /** What to show. Falls back to the id when the file names no label. */
  label: string;
  command: string;
  args: readonly string[];
  source: TaskSource;
}

export interface ParsedTasks {
  tasks: Task[];
  /** One sentence per dropped entry, for the notification the service raises. */
  problems: string[];
}

/** A plain name, so a task id can never be mistaken for a path or a flag. */
const TASK_ID = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

/**
 * What Nox writes when asked to create the file. Must parse, and must produce
 * no problems. A test says both, because an example that warns on first open
 * teaches the reader that warnings are normal.
 */
export const TASKS_EXAMPLE = `{
  "tasks": [
    {
      "id": "test",
      "label": "Run tests",
      "command": "npm",
      "args": ["test"]
    },
    {
      "id": "build",
      "label": "Build",
      "command": "npm",
      "args": ["run", "build"]
    }
  ]
}
`;

/**
 * The key an approval is remembered under.
 *
 * **Not the task's id.** Keying on the name would let a repository earn a yes
 * for `test` meaning `npm test`, then change the file and inherit that yes for
 * something else under a name already trusted, with the edit arriving through
 * a pull or a branch switch that the user is not looking at. Keying on the
 * argv means any change to what a task runs is a new question.
 *
 * **And not the argv alone**, which is what this was until a review on
 * 2026-08-30 found the hole. `npm test`, `make`, `cargo test` and every other
 * realistic task are argvs whose entire meaning comes from the directory they
 * run in, and the directory is not in them. Approving `npm test` in a
 * repository you trust, then opening a stranger's clone in the same window,
 * left the approval standing: same argv, same fingerprint, no second question,
 * and `package.json` in the new root decides what actually runs. The root is
 * therefore part of the key, which also means returning to the first
 * repository does not ask again.
 *
 * NUL is the separator because it is the one byte a path or an argv element
 * cannot contain: the OS uses it to terminate them, and `parseTasks` refuses
 * one outright rather than trusting that. So no two distinct keys can collide
 * by construction rather than by being unlikely to. A separator like a space
 * would let `["a b"]` and `["a", "b"]` collide.
 */
export function taskFingerprint(
  task: Pick<Task, 'command' | 'args'>,
  root: string | null,
): string {
  return [root ?? '', task.command, ...task.args].join('\0');
}

/** The argv as a person reads it, for the confirmation dialog and the panel. */
export function taskCommandLine(task: Pick<Task, 'command' | 'args'>): string {
  return [task.command, ...task.args].map(quoteIfNeeded).join(' ');
}

/**
 * Quote an argv element that would otherwise read as more than one.
 *
 * Presentation only, and deliberately never parsed back: nothing in Nox turns
 * this string into an argv again. It exists so that a task whose argument
 * contains a space cannot be *displayed* as two arguments in the one dialog
 * whose entire job is showing the user what will run.
 */
function quoteIfNeeded(part: string): string {
  return SAFE_BARE.test(part) ? part : JSON.stringify(part);
}

/**
 * An argument that needs no quoting: printable ASCII, and none of the
 * characters a reader would take as shell syntax.
 *
 * An allowlist rather than a list of things to escape, and the difference is
 * the whole point. The denylist this replaced was `[\s"'\\$`]`, and
 * JavaScript's `\s` does not include U+200B ZERO WIDTH SPACE or U+202E RIGHT
 * TO LEFT OVERRIDE. Both passed through unquoted, so `["test"]` and
 * `["test\u200b"]` rendered as the identical string `npm test` while
 * producing different keys: the dialog would open a second time showing text
 * indistinguishable from the text already approved, which trains a person to
 * click Run. A dialog whose entire job is showing what will run has to be a
 * faithful function of the argv, and only an allowlist gives that.
 */
const SAFE_BARE = /^[A-Za-z0-9_./=:@+-]+$/;

export function parseTasks(value: unknown, source: TaskSource): ParsedTasks {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { tasks: [], problems: ['tasks.json is not an object'] };
  }

  const raw = (value as Record<string, unknown>).tasks;
  if (raw === undefined) return { tasks: [], problems: [] };
  if (!Array.isArray(raw)) return { tasks: [], problems: ['tasks is not a list'] };

  const tasks: Task[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`task ${index} is not an object`);
      continue;
    }
    const record = entry as Record<string, unknown>;

    const id = stringField(record, 'id');
    if (id === null) {
      problems.push(`task ${index} has no id`);
      continue;
    }
    if (!TASK_ID.test(id)) {
      problems.push(`task "${id}" is not a plain name`);
      continue;
    }
    if (seen.has(id)) {
      // First wins, so that reading top to bottom matches what runs.
      problems.push(`task "${id}" is declared twice`);
      continue;
    }

    const command = stringField(record, 'command');
    if (command === null) {
      problems.push(`task "${id}" has no command`);
      continue;
    }

    const args = argsOf(record);
    if (typeof args === 'string') {
      problems.push(`task "${id}" ${args}`);
      continue;
    }

    seen.add(id);
    tasks.push({ id, label: stringField(record, 'label') ?? id, command, args, source });
  }

  return { tasks, problems };
}

/**
 * The arguments, or a sentence saying why there aren't any.
 *
 * Strict where `parseManifest`'s equivalent is lenient: it filters
 * non-strings out of a plugin's `args`, and here a bad element refuses the
 * whole task. Silently dropping element 2 of an argv changes what the command
 * *does* while leaving it looking runnable, and the dialog in §4 would then
 * show a line the author never wrote.
 */
function argsOf(record: Record<string, unknown>): readonly string[] | string {
  const raw = record.args;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'has args that are not a list';
  for (const arg of raw) {
    if (typeof arg !== 'string') return 'has an argument that is not a string';
    // See `stringField`. Rust refuses an interior NUL at spawn on both Unix
    // and Windows, so this was never executable, but it was a fingerprint
    // collision and the comment on that function claimed it could not be.
    if (arg.includes('\0')) return 'has an argument containing a NUL';
  }
  return raw as string[];
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  // JSON can carry a NUL that argv cannot. `taskFingerprint` joins on one and
  // calls the result collision-free "by construction", which was only true of
  // `execve`, not of this parser: `{"command":"npm\u0000run"}` and
  // `{"command":"npm","args":["run"]}` produced the same key. Rejected here so
  // the claim is a fact about the code rather than about the OS underneath it.
  return value.includes('\0') ? null : value;
}

/**
 * The user's tasks, then the project's that they do not shadow.
 *
 * A shadowed project task is *reported*, not dropped silently. A repository
 * must not be able to take over the name of a task the user already trusted,
 * and finding that out by having your own task quietly stop running is the
 * worst way to learn it.
 */
export function mergeTasks(
  user: readonly Task[],
  project: readonly Task[],
): { tasks: Task[]; shadowed: Task[] } {
  const byUser = new Set(user.map((task) => task.id));
  const shadowed = project.filter((task) => byUser.has(task.id));
  return {
    tasks: [...user, ...project.filter((task) => !byUser.has(task.id))],
    shadowed,
  };
}
