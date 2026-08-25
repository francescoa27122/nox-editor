import { progressLabel } from '@core/lsp-progress';
import type { SessionStatusRow } from '@services/lsp';

/**
 * What the status bar says about the language servers.
 *
 * Separate from the component because the interesting half is a decision
 * rather than markup: a failure must name the server that failed, and must
 * survive one healthy server sitting next to a broken one. A partial failure
 * reported as an aggregate is the kind people notice weeks later, wondering
 * why one language never had diagnostics.
 *
 * The second decision is newer and was got wrong for a while. The bar has two
 * things to say and they are not the same fact: how the *subsystem* is doing,
 * and whether *this file* has language intelligence at all. Answering the
 * second with the first is what made the bar read `typescript-language-server`
 * beside an open `main.py` — a global aggregate wearing a per-file label, in
 * the one place a user reads as "this is what is analysing what I am looking
 * at". So the aggregate label never names a server that does not serve the
 * active file, and the per-file item says "no language server configured" out
 * loud rather than leaving the Language commands to grey out, which reads as
 * "not applicable" rather than "not set up".
 */

/** Sessions serving `languageId`, or all of them when no file is open. */
function serving(
  sessions: readonly SessionStatusRow[],
  languageId: string | null,
): readonly SessionStatusRow[] {
  if (languageId === null) return sessions;
  return sessions.filter((session) => session.languages.includes(languageId));
}

function countLabel(sessions: readonly SessionStatusRow[]): string {
  return sessions.length === 1 ? '1 server' : `${sessions.length} servers`;
}

/**
 * The label, or null when there is nothing worth taking up room for.
 *
 * `activeLanguageId` is the language of the buffer in front of the user, and
 * null when nothing is open.
 */
export function serverStatusLabel(
  sessions: readonly SessionStatusRow[],
  activeLanguageId: string | null = null,
): string | null {
  // Not "0 servers": someone who has never configured one should not be told
  // about a subsystem they are not using.
  if (sessions.length === 0) return null;

  // A dead server outranks everything, including relevance. It is an alarm
  // about the subsystem rather than a claim about this file — the word
  // "failed" beside the name makes that unambiguous — and a partial failure
  // nobody is told about is exactly the one that gets noticed weeks later.
  const failed = sessions.find((session) => session.status === 'failed');
  if (failed) return `${failed.name} — failed`;

  const relevant = serving(sessions, activeLanguageId);

  // Nothing running here has anything to do with the file in front of the
  // user. Name nobody: a count is true, claims nothing about this buffer, and
  // keeps the tooltip — which lists every server's real state — reachable.
  // The per-file item is where the absence is spelled out.
  if (relevant.length === 0) return countLabel(sessions);

  // Above `starting`, and above a plain name, because it is the only state
  // here that answers "is it doing anything?". rust-analyzer spends its first
  // half-minute indexing, during which it is `running` and answers nothing —
  // a status line reading just its name is true and reads as broken.
  const working = relevant.find((session) => session.progress.length > 0);
  if (working) {
    const label = progressLabel(working.progress);
    if (label !== null) return `${working.name} — ${label}`;
  }

  const starting = relevant.find((session) => session.status === 'initializing');
  if (starting) return `${starting.name} — starting`;

  return relevant.length === 1 ? relevant[0]!.name : countLabel(relevant);
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

export interface ActiveLanguage {
  /** As `BufferSnapshot.languageId` spells it. */
  id: string;
  /** As `BufferSnapshot.languageName` spells it — what the item renders. */
  name: string;
  /** Whether a CodeMirror grammar is installed for it. */
  hasGrammar: boolean;
}

export interface ActiveLanguageStatus {
  /** The tooltip, in full. */
  title: string;
  tone: 'normal' | 'muted' | 'warn';
  /** The command a click dispatches, or null when the item is a readout. */
  commandId: string | null;
}

/**
 * What the per-file language item says about the buffer in front of the user.
 *
 * This is the control that already carried this exact class of fact —
 * `"Python — no grammar installed"`, dimmed — so the missing-server case
 * reuses it rather than inventing a second vocabulary for "something this
 * file could have is not set up". Both sentences can be true at once, so they
 * are composed rather than ranked.
 */
export function activeLanguageStatus(
  language: ActiveLanguage,
  sessions: readonly SessionStatusRow[],
): ActiveLanguageStatus {
  const relevant = serving(sessions, language.id);
  // Worst first, and the same order the aggregate uses, so the two halves of
  // the bar can never describe the same server differently.
  const notable =
    relevant.find((session) => session.status === 'failed') ??
    relevant.find((session) => session.status === 'initializing') ??
    relevant[0] ??
    null;

  const parts: string[] = [];
  if (!language.hasGrammar) parts.push('no grammar installed');

  let tone: ActiveLanguageStatus['tone'] = language.hasGrammar ? 'normal' : 'muted';
  let commandId: string | null = null;

  if (notable) {
    if (notable.status === 'failed') {
      parts.push(`${notable.name} failed`);
      // Louder than muted: this file *should* have language intelligence and
      // does not, which is a different thing from never having had any.
      tone = 'warn';
    } else if (notable.status === 'initializing') {
      parts.push(`${notable.name} starting`);
    } else {
      parts.push(notable.name);
    }
  } else if (sessions.length > 0) {
    // Only once the user has configured *something*. Telling someone who has
    // never set up a language server that this file has none would advertise
    // a subsystem they are not using, which is the same stance the aggregate
    // label takes by rendering nothing at all.
    parts.push('no language server configured');
    tone = 'muted';
    commandId = 'lsp.configure';
  }

  return {
    title: parts.length > 0 ? `${language.name} — ${parts.join(', ')}` : language.name,
    tone,
    commandId,
  };
}
