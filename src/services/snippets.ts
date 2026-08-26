import { parseSnippetFile, snippetsFor, type Snippet, type SnippetFile } from '@core/snippets';
import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';

/**
 * The user's own snippets.
 *
 * A separate `snippets.json` rather than settings, for the reason
 * `servers.json` and `agents.json` give: this is a *nested table of records*
 * and the settings UI is generated from a schema of scalars.
 *
 * **A failed load never empties a working set.** The file is edited inside
 * Nox, and the watcher fires on every save — so a half-written file is the
 * ordinary state during editing, not an exceptional one. Dropping the
 * snippets on each broken parse would make the file impossible to edit in
 * place, and would do it by removing the thing the author was in the middle of
 * adding to. The error is said out loud instead, and the last good set stays
 * live.
 */

export const SNIPPETS_FILE = 'snippets.json';

/** What Nox writes when asked to create the file. Must parse — a test says so. */
export const SNIPPETS_TEMPLATE = `{
  "//": "Your own snippets. The key is what you type; $1, $2 are the stops Tab moves between, and $0 is where the cursor ends up.",

  "*": {
    "todo": "TODO(\${1:who}): \${0:what}"
  },

  "typescript": {
    "log": "console.log(\${1:value})$0",
    "fn": {
      "body": ["function \${1:name}(\${2:args}) {", "  $0", "}"],
      "description": "A function declaration"
    }
  }
}
`;

export class SnippetService {
  /** Set when the file exists but could not be read. The set stays live. */
  readonly error = new Signal<string | null>(null);
  /** Bumped whenever the set changes, so the editor can refresh its source. */
  readonly revision = new Signal(0);

  #platform: Platform;
  #snippets: SnippetFile = new Map();

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.#platform.readConfigFile(SNIPPETS_FILE);
    } catch {
      // No file is not a problem — it is the state everyone starts in.
      this.#replace(new Map());
      this.error.set(null);
      return;
    }

    if (!raw || raw.trim().length === 0) {
      this.#replace(new Map());
      this.error.set(null);
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      // Said, not swallowed: a typo here looks exactly like having written no
      // snippets, which is what the author was trying to stop being true.
      this.error.set(error instanceof Error ? error.message : 'snippets.json is not valid JSON');
      return;
    }

    const { snippets, problems } = parseSnippetFile(value);
    this.#replace(snippets);
    this.error.set(problems.length > 0 ? problems.join('; ') : null);
  }

  /** The snippets offered in a language: its own, plus the wildcard's. */
  forLanguage(languageId: string): Snippet[] {
    return snippetsFor(this.#snippets, languageId);
  }

  /** Create the file with a working example if it does not exist yet. */
  async ensureFile(): Promise<void> {
    const existing = await this.#platform.readConfigFile(SNIPPETS_FILE).catch(() => null);
    if (existing !== null && existing.trim().length > 0) return;
    await this.#platform.writeConfigFile(SNIPPETS_FILE, SNIPPETS_TEMPLATE);
  }

  #replace(snippets: SnippetFile): void {
    this.#snippets = snippets;
    this.revision.set(this.revision.get() + 1);
  }
}
