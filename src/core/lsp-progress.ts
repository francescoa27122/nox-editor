/**
 * Work-done progress: what a server is busy with, and how far in.
 *
 * The symptom this removes is specific. rust-analyzer indexes a cold project
 * for thirty seconds or more before it can answer anything, and until now it
 * did that in complete silence — hover returned nothing, go-to-definition
 * returned nothing, and the only available reading was that the language
 * server was broken. It was working. Nobody could tell.
 *
 * Pure and here for the usual reason: the wire shape has three variants, an
 * optional percentage that servers clamp differently, and an end that may or
 * may not carry a message. That is a lot of small decisions to get right, and
 * every one of them is invisible against a real server that happens not to
 * exercise it.
 */

/** One thing a server is doing. */
export interface WorkDone {
  /** Set at `begin` and never changed — the specification forbids retitling. */
  title: string;
  /** The latest `message`, if the server has sent one. */
  message?: string;
  /** 0-100, only when the server reports one. */
  percentage?: number;
}

export type ProgressEvent =
  | { kind: 'begin'; token: string; title: string; message?: string; percentage?: number }
  | { kind: 'report'; token: string; message?: string; percentage?: number }
  | { kind: 'end'; token: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A token as a string.
 *
 * The specification allows an integer or a string, and a server is free to use
 * `1` and `"1"` for different pieces of work. Keying the map on the *rendered*
 * form would merge them, so the type is kept in the key: `n:1` is not `s:1`.
 */
export function progressToken(raw: unknown): string | null {
  if (typeof raw === 'string') return `s:${raw}`;
  if (typeof raw === 'number' && Number.isFinite(raw)) return `n:${raw}`;
  return null;
}

/** Clamp a reported percentage, or drop it if it is not a number. */
function percentage(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  // Servers have been seen to send 0-1 and 0-100 and to overshoot slightly at
  // the end. Clamping is the difference between a progress bar and a bug
  // report; it is not this layer's job to guess which scale was meant.
  return Math.max(0, Math.min(100, raw));
}

/** Read one `$/progress` notification, or `null` if it is not one Nox tracks. */
export function progressEvent(params: unknown): ProgressEvent | null {
  if (!isRecord(params)) return null;
  const token = progressToken(params.token);
  if (token === null) return null;

  const value = params.value;
  if (!isRecord(value)) return null;

  if (value.kind === 'begin') {
    // A `begin` with no title is malformed; the title is the only thing that
    // can be rendered, so there is nothing to show and nothing to remember.
    if (typeof value.title !== 'string' || value.title.trim() === '') return null;
    const event: ProgressEvent = { kind: 'begin', token, title: value.title.trim() };
    if (typeof value.message === 'string') event.message = value.message;
    const percent = percentage(value.percentage);
    if (percent !== undefined) event.percentage = percent;
    return event;
  }

  if (value.kind === 'report') {
    const event: ProgressEvent = { kind: 'report', token };
    if (typeof value.message === 'string') event.message = value.message;
    const percent = percentage(value.percentage);
    if (percent !== undefined) event.percentage = percent;
    return event;
  }

  if (value.kind === 'end') return { kind: 'end', token };

  // Partial-result progress shares `$/progress` and has no `kind` at all.
  // Ignored rather than guessed at: it is a different feature.
  return null;
}

/**
 * Apply an event, returning a new map.
 *
 * A new map rather than a mutation because this feeds a `Signal`, and a signal
 * whose value is mutated in place cannot tell subscribers anything changed.
 *
 * A `report` for a token that never began is **dropped, not invented**. The
 * alternative is a row with no title, and a title is the only part a person
 * can act on; an untitled bar saying 40% is worse than silence. This happens
 * for real — an `end` can be processed after a restart while a late `report`
 * from the old process is still in flight.
 */
export function applyProgress(
  current: ReadonlyMap<string, WorkDone>,
  event: ProgressEvent,
): Map<string, WorkDone> {
  const next = new Map(current);

  if (event.kind === 'end') {
    next.delete(event.token);
    return next;
  }

  if (event.kind === 'begin') {
    const entry: WorkDone = { title: event.title };
    if (event.message !== undefined) entry.message = event.message;
    if (event.percentage !== undefined) entry.percentage = event.percentage;
    next.set(event.token, entry);
    return next;
  }

  const existing = current.get(event.token);
  if (!existing) return next;

  // A `report` carrying neither field is a keep-alive; it must not blank the
  // message the last one set.
  const entry: WorkDone = { title: existing.title };
  const message = event.message ?? existing.message;
  if (message !== undefined) entry.message = message;
  const percent = event.percentage ?? existing.percentage;
  if (percent !== undefined) entry.percentage = percent;
  next.set(event.token, entry);
  return next;
}

/**
 * One line for the status bar, or `null` when nothing is in flight.
 *
 * Takes the ordered array the status row carries rather than the token map the
 * service keeps: the token is the service's bookkeeping and means nothing to a
 * renderer, and an array that is already in the right order does not need to
 * be rebuilt into a map to be read.
 *
 * The **oldest** piece of work wins when there is more than one, because that
 * is the one the user has been waiting on. `Map` preserves insertion order, so
 * publishing its values in order is that order.
 *
 * The message is appended only when it adds something: rust-analyzer sends
 * titles like "Indexing" with messages like "3/840 (core)", which reads well;
 * a server that repeats the title as the message would otherwise get it twice.
 */
export function progressLabel(progress: readonly WorkDone[]): string | null {
  const first = progress[0];
  if (first === undefined) return null;

  const { title, message, percentage: percent } = first;
  const detail = message !== undefined && message.trim() !== '' && message.trim() !== title
    ? `${title} ${message.trim()}`
    : title;

  return percent === undefined ? detail : `${detail} ${Math.round(percent)}%`;
}
