/**
 * Cross-session memory for an agent, in one JSONL file.
 *
 * Nox has no persistence verb — `context.*`, `command.execute`,
 * `proposal.stage`, `session.note`, `session.summary` is the whole vocabulary,
 * and none of them store anything. That is not an omission. An agent is a
 * separate process, so what it remembers is its own business, kept on its own
 * side of the pipe. Nothing here needs a line of editor code, and the editor
 * cannot be made slower or larger by any of it.
 *
 * Used two ways:
 *
 *   // memory and nothing else — recalls, records, proposes nothing
 *   node examples/orchestrator-agent.mjs examples/orchestrators/memory.mjs [file.jsonl]
 *
 *   // wrapped round a real orchestrator, which is the point
 *   import { remembering } from './memory.mjs';
 *   export default remembering(myOrchestrator);
 *
 * The store is append-only and line-oriented on purpose. An agent that is
 * killed mid-write leaves one torn line rather than an unreadable file, and
 * `read()` below skips what will not parse instead of throwing the whole
 * history away. Recall is token overlap plus recency — no embeddings, no
 * index, no vector database. At one person's workspace the candidate set is
 * hundreds of entries, which is well under the size where an approximate
 * index starts beating a linear scan.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_PATH = join(homedir(), '.nox', 'agent-memory.jsonl');

/** Words carried by every instruction, so their overlap means nothing. */
const NOISE = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'was', 'are',
  'you', 'your', 'its', 'but', 'not', 'all', 'can', 'has', 'have', 'file',
]);

function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !NOISE.has(word)),
  );
}

export function createMemory({ path = DEFAULT_PATH, now = () => new Date().toISOString() } = {}) {
  /**
   * Every entry, oldest first. A line that will not parse is dropped rather
   * than fatal: the realistic way this file goes wrong is a process killed
   * between the write and the newline, and losing that one entry is a much
   * better outcome than losing the file.
   */
  function read() {
    if (!existsSync(path)) return [];
    const entries = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skipped, deliberately and silently — see above.
      }
    }
    return entries;
  }

  return {
    read,

    /** Append one entry. Returns what was written, timestamp included. */
    record(entry) {
      const stored = { at: now(), ...entry };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(stored)}\n`, 'utf-8');
      return stored;
    },

    /**
     * The entries worth putting in front of the model for `query`.
     *
     * Scored on overlap, tie-broken by recency, and **nothing with a score of
     * zero is returned**. Padding the result out with recent-but-unrelated
     * entries is worse than returning none: the model cannot tell recall from
     * filler, and a confident irrelevant memory is how an agent talks itself
     * into the wrong file.
     */
    recall(query, { workspace = null, limit = 3 } = {}) {
      const wanted = tokens(query);
      if (wanted.size === 0) return [];

      return read()
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => workspace === null || entry.workspace === workspace)
        .map(({ entry, index }) => {
          const against = tokens(`${entry.instruction ?? ''} ${entry.summary ?? ''}`);
          let score = 0;
          for (const word of wanted) if (against.has(word)) score += 1;
          return { entry, index, score };
        })
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .slice(0, limit)
        .map((scored) => scored.entry);
    },
  };
}

/** How recalled entries reach a model: appended to the context it is given. */
export function formatRecall(entries) {
  if (entries.length === 0) return '';
  const lines = entries.map(
    (entry) => `- ${entry.at}: "${entry.instruction}" → ${entry.summary ?? 'no summary'}`,
  );
  return `\n\nEarlier in this workspace:\n${lines.join('\n')}`;
}

/**
 * Wrap an orchestrator so it recalls before thinking and records afterwards.
 *
 * `inner` may be null, which is the memory-on-its-own mode: it still recalls
 * and still records, and proposes nothing. That is the honest demonstration
 * of what the memory is worth by itself — a session that leaves a trace the
 * next one can find.
 */
export function remembering(inner, memory = createMemory({ path: process.argv[3] || undefined })) {
  return async function think(instruction, context, opened, read) {
    const tree = await read('context.workspaceTree', { depth: 1 });
    const workspace = tree.root;

    const recalled = memory.recall(instruction, { workspace });
    if (recalled.length > 0) {
      await read('session.note', {
        text: `Recalled ${recalled.length} earlier session(s) in this workspace.`,
      });
    }

    const plan = inner
      ? await inner(instruction, `${context}${formatRecall(recalled)}`, opened, read)
      : {
          edits: [],
          summary:
            recalled.length > 0
              ? `Recalled ${recalled.length} earlier session(s); no orchestrator is wired in, so nothing was proposed.`
              : 'Nothing remembered about this workspace yet, and no orchestrator is wired in.',
        };

    // Recorded after the fact, so what is stored is what happened rather than
    // what was intended. An orchestrator that threw records nothing, which is
    // correct: a failed run has no outcome to recall.
    memory.record({
      workspace,
      instruction,
      summary: plan?.summary ?? null,
      files: (plan?.edits ?? [])
        .map((edit) => opened.find((buffer) => buffer.id === edit.bufferId)?.path)
        .filter((path) => typeof path === 'string'),
    });

    return plan;
  };
}

export default remembering(null);
