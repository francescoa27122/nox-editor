import { pathToUri } from '@core/uri';
import type { BufferSnapshot, WorkspaceService } from '@services/workspace';

/**
 * Keeps a server's copy of the open documents in step with Nox's.
 *
 * Full-text sync, deliberately, even where a server offers incremental.
 * Incremental is a performance optimisation whose failure mode is silent: one
 * off-by-one in a range conversion desynchronises the server's copy, and from
 * then on every diagnostic lands on the wrong line while looking entirely
 * plausible. Full sync cannot drift.
 *
 * The version sent is the buffer's own revision rather than a counter kept
 * here, so a diagnostic batch can be checked against the text it was computed
 * from. Two counters would drift, and the drift would be invisible.
 */

/** Just enough of `LspSession` to be told things. */
export interface NotifyTarget {
  notify(method: string, params?: unknown): Promise<void>;
}

export interface DocumentSyncOptions {
  /** Long enough that a typed word is one message, short enough to feel live. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;

interface Attached {
  session: NotifyTarget;
  languages: ReadonlySet<string>;
}

interface Open {
  uri: string;
  languageId: string;
  revision: number;
}

export class DocumentSync {
  #workspace: WorkspaceService;
  #debounceMs: number;
  #attached: Attached[] = [];
  /** What each open buffer was last reported as, by buffer id. */
  #open = new Map<string, Open>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** What each pending timer would send, so `flush` can send it early. */
  #pending = new Map<string, () => void>();
  #unsubscribe: (() => void) | null = null;

  constructor(workspace: WorkspaceService, options: DocumentSyncOptions = {}) {
    this.#workspace = workspace;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#unsubscribe = workspace.buffers.subscribe(() => this.#reconcile());
  }

  /** Start telling `session` about documents in the languages it serves. */
  attach(session: NotifyTarget, languages: readonly string[]): void {
    this.#attached.push({ session, languages: new Set(languages) });
    this.#reconcile();
  }

  /** The documents the server has been told about. */
  openUris(): string[] {
    return [...this.#open.values()].map((document) => document.uri);
  }

  /**
   * Send every debounced change now.
   *
   * The debounce is right for keeping a server's copy roughly current while
   * someone types. It is wrong the moment something *asks* the server about
   * the document: completion fires on the keystroke, well inside the window,
   * and a server that has not been sent the change answers about the text it
   * still holds. Typing `console.` and being offered 2010 globals instead of
   * 20 members is exactly that.
   */
  flush(): void {
    for (const [id, timer] of this.#timers) {
      clearTimeout(timer);
      this.#pending.get(id)?.();
    }
    this.#timers.clear();
    this.#pending.clear();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /**
   * Diff what is open against what the servers were told, and say the
   * difference. Driven off the buffer list rather than off edit events because
   * that list is already republished on every document change — which is
   * exactly the cadence this needs, and one fewer thing to keep in step.
   */
  #reconcile(): void {
    const buffers = this.#workspace.buffers.get();
    const seen = new Set<string>();

    for (const buffer of buffers) {
      if (buffer.path === null) continue; // Untitled: no URI to give a server.
      // A buffer over `LARGE_FILE_BYTES` is never announced to a server at
      // all (A4-004). The other option, didOpen once and then no didChange,
      // is the dishonest one: the server holds a copy that silently goes
      // stale from the first keystroke, and every diagnostic it publishes
      // afterwards lands on a line that has moved while looking entirely
      // plausible, which is the same failure full-text sync exists to
      // prevent. A document the server was never told about cannot drift.
      //
      // Deliberately before `seen.add`: a buffer that crosses the line on an
      // external reload is already open at the server, and falling through to
      // the loop below sends it a didClose. That is the honest end of the
      // conversation rather than an abandoned one.
      if (buffer.isLarge) continue;
      seen.add(buffer.id);

      const known = this.#open.get(buffer.id);
      if (!known) {
        this.#opened(buffer);
        continue;
      }
      if (known.revision !== buffer.revision) this.#changed(buffer, known);
    }

    for (const [id, document] of [...this.#open]) {
      if (seen.has(id)) continue;
      this.#closed(id, document);
    }
  }

  #sessionsFor(languageId: string): NotifyTarget[] {
    return this.#attached
      .filter((attached) => attached.languages.has(languageId))
      .map((attached) => attached.session);
  }

  #opened(buffer: BufferSnapshot): void {
    const sessions = this.#sessionsFor(buffer.languageId);
    if (sessions.length === 0) return;

    const uri = pathToUri(buffer.path!);
    const text = this.#workspace.textOf(buffer.id);
    if (text === undefined) return;

    this.#open.set(buffer.id, { uri, languageId: buffer.languageId, revision: buffer.revision });

    for (const session of sessions) {
      void session.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: buffer.languageId, version: buffer.revision, text },
      });
    }
  }

  #changed(buffer: BufferSnapshot, known: Open): void {
    known.revision = buffer.revision;

    const existing = this.#timers.get(buffer.id);
    if (existing) clearTimeout(existing);

    const send = () => {
      this.#timers.delete(buffer.id);
      this.#pending.delete(buffer.id);

      // Read at send time, not at schedule time: the point of the debounce is
      // that the text moved on, and the version must describe the text
      // actually being sent.
      const text = this.#workspace.textOf(buffer.id);
      const revision = this.#workspace.revisionOf(buffer.id);
      if (text === undefined) return;

      for (const session of this.#sessionsFor(known.languageId)) {
        void session.notify('textDocument/didChange', {
          textDocument: { uri: known.uri, version: revision },
          contentChanges: [{ text }],
        });
      }
    };

    this.#pending.set(buffer.id, send);
    this.#timers.set(buffer.id, setTimeout(send, this.#debounceMs));
  }

  #closed(id: string, document: Open): void {
    // Dropped rather than flushed: a didChange arriving after didClose
    // describes a document the server has already forgotten, and servers are
    // entitled to treat that as a protocol error.
    const timer = this.#timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    this.#pending.delete(id);

    this.#open.delete(id);

    for (const session of this.#sessionsFor(document.languageId)) {
      void session.notify('textDocument/didClose', {
        textDocument: { uri: document.uri },
      });
    }
  }
}
