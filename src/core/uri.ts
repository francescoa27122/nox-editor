/**
 * Paths to `file://` URIs and back.
 *
 * Its own module, with its own tests, because this is a silent-corruption
 * source rather than a formatting detail: a server told the wrong URI reports
 * diagnostics against a document nobody is looking at, and says nothing about
 * the one they are. Windows is a first-class platform here, so a drive letter
 * and a UNC share are first-class cases rather than afterthoughts.
 *
 * `uriToPath` returns the *native* spelling — backslashes for a Windows or UNC
 * path — because that is what the rest of Nox uses. `core/path.ts` says so and
 * carries a `separatorOf` to preserve it, so a URI helper that handed back
 * forward slashes would produce paths every other helper disagreed with.
 */

/** `C:` at the start of a path. */
const DRIVE = /^([A-Za-z]):/;
/** `/c:` or `/c%3A` at the start of a decoded URI path. */
const URI_DRIVE = /^\/([A-Za-z]):/;

export function pathToUri(path: string): string {
  const slashed = path.replace(/\\/g, '/');

  // UNC: `//server/share/a.ts` — the host becomes the URI authority, so it
  // must not be encoded as though it were a path segment.
  if (slashed.startsWith('//')) {
    const [, , host = '', ...rest] = slashed.split('/');
    const tail = rest.map(encodeURIComponent).join('/');
    return `file://${host}${tail ? `/${tail}` : ''}`;
  }

  const drive = DRIVE.exec(slashed);
  if (drive) {
    // Lower-cased and percent-encoded, matching what VS Code sends. A bare
    // colon is legal in a path and ambiguous in a URI.
    const rest = slashed.slice(drive[0].length).replace(/^\//, '');
    const tail = rest.split('/').map(encodeURIComponent).join('/');
    return `file:///${drive[1]!.toLowerCase()}%3A${tail ? `/${tail}` : ''}`;
  }

  const tail = slashed.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
  return `file:///${tail}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    throw new Error(`not a file URI: ${uri}`);
  }

  const rest = uri.slice('file://'.length);

  // An authority means UNC; a local path's `file:///...` leaves it empty.
  if (!rest.startsWith('/')) {
    const slash = rest.indexOf('/');
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? '' : decodeURIComponent(rest.slice(slash));
    return `\\\\${host}${tail.replace(/\//g, '\\')}`;
  }

  const decoded = decodeURIComponent(rest);
  const drive = URI_DRIVE.exec(decoded);
  if (drive) {
    const tail = decoded.slice(drive[0].length);
    return `${drive[1]!.toUpperCase()}:${tail.replace(/\//g, '\\')}`;
  }
  return decoded;
}
