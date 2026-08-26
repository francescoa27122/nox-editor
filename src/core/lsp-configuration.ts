/**
 * Answering `workspace/configuration`.
 *
 * A server asks this when it wants the settings the *user* has for it —
 * pyright's `python.analysis.*`, gopls's `gopls.*`, rust-analyzer's
 * `rust-analyzer.*`. All three ask during start-up. Until Nox answered, they
 * fell back to their own defaults and nothing anywhere said so, which is the
 * worst shape a gap can have: the server works, it just does not do what the
 * user configured.
 *
 * Pure and here rather than in the session for the usual reason — the shape of
 * the reply is fiddly in exactly the way that is invisible against a real
 * server, and this way it is fifty tests instead of one integration run.
 */

/** One entry of the `items` array a server sends. */
export interface ConfigurationItem {
  /** The document or folder the question is about. Nox has one root, so unused. */
  scopeUri?: string;
  /** A dotted path — `python.analysis`. Absent means "everything you have". */
  section?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The items a server asked about, or `[]` if the request is not shaped like
 * one. A malformed request gets an empty answer rather than a thrown error:
 * the transport turns a throw into an error response, and a server that asked
 * badly is better off with a reply it can read than with an error it probably
 * logs and ignores.
 */
export function configurationItems(params: unknown): ConfigurationItem[] {
  if (!isRecord(params) || !Array.isArray(params.items)) return [];
  return params.items.map((item) => {
    if (!isRecord(item)) return {};
    const out: ConfigurationItem = {};
    if (typeof item.section === 'string') out.section = item.section;
    if (typeof item.scopeUri === 'string') out.scopeUri = item.scopeUri;
    return out;
  });
}

/**
 * Walk a dotted section path into `settings`.
 *
 * `null` for anything not found, which is what the specification asks for and
 * what every server treats as "the user has not set this". Distinguishing
 * "absent" from "explicitly null" would be a finer answer than the wire format
 * can carry, so it is not attempted.
 *
 * Only plain objects are traversed. A section reaching *into* an array or a
 * string — `python.analysis.0`, or a path through a value the user wrote as a
 * scalar — resolves to `null` rather than to an element, because a server
 * asking for a section means a settings namespace and an array index is a
 * misunderstanding on one side or the other.
 */
export function sectionValue(settings: unknown, section: string | undefined): unknown {
  if (settings === undefined) return null;
  // No section is the whole object, which is how gopls asks.
  if (section === undefined || section === '') return settings ?? null;
  if (!isRecord(settings)) return null;

  let current: unknown = settings;
  for (const key of section.split('.')) {
    if (!isRecord(current)) return null;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return null;
    current = current[key];
  }
  return current ?? null;
}

/**
 * The full reply: one value per requested item, in the order asked.
 *
 * **The length and the order are the contract**, not a convenience. A server
 * reads the result positionally — `result[i]` is the answer to `items[i]` —
 * so dropping an unknown section instead of answering `null` for it shifts
 * every later answer onto the wrong question. That is a bug which looks like
 * the user misconfiguring the *other* setting, and it is the reason this
 * returns a mapped array rather than a filtered one.
 */
export function configurationReply(params: unknown, settings: unknown): unknown[] {
  return configurationItems(params).map((item) => sectionValue(settings, item.section));
}
