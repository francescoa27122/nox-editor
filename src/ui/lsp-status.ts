import type { SessionStatusRow } from '@services/lsp';

/**
 * What the status bar says about the language servers.
 *
 * Separate from the component because the interesting half is a decision
 * rather than markup: a failure must name the server that failed, and must
 * survive one healthy server sitting next to a broken one. A partial failure
 * reported as an aggregate is the kind people notice weeks later, wondering
 * why one language never had diagnostics.
 */

/** Worst first: a failure outranks a start, which outranks running. */
function worst(sessions: readonly SessionStatusRow[]): SessionStatusRow | null {
  return (
    sessions.find((session) => session.status === 'failed') ??
    sessions.find((session) => session.status === 'initializing') ??
    sessions[0] ??
    null
  );
}

/** The label, or null when there is nothing worth taking up room for. */
export function serverStatusLabel(sessions: readonly SessionStatusRow[]): string | null {
  // Not "0 servers": someone who has never configured one should not be told
  // about a subsystem they are not using.
  if (sessions.length === 0) return null;

  const notable = worst(sessions);
  if (!notable) return null;

  if (notable.status === 'failed') return `${notable.name} — failed`;
  if (notable.status === 'initializing') return `${notable.name} — starting`;

  return sessions.length === 1 ? notable.name : `${sessions.length} servers`;
}

/** The tooltip: everything the status line had no room for. */
export function serverStatusTitle(sessions: readonly SessionStatusRow[]): string {
  return sessions
    .map((session) => {
      const lines = [`${session.name}: ${session.status}`];
      if (session.error) lines.push(session.error);
      // Its last words on stderr are the only explanation anyone will get.
      if (session.stderr.length > 0) lines.push(...session.stderr.slice(-5));
      return lines.join('\n');
    })
    .join('\n\n');
}
