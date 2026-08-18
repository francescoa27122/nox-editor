import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToUri } from '../src/core/uri';
import { LspSession } from '../src/services/lsp/session';
import { spawnLanguageServer } from './support/lsp-child';

/**
 * Against a real `typescript-language-server`.
 *
 * Every other test in this suite drives a fake, which is the right default —
 * fakes can stage a crash mid-handshake and a reply out of order, and a real
 * server cannot. But a fake only ever confirms what its author already
 * believed. This is the test that can contradict the design, and two things in
 * particular were built on assumptions it can check:
 *
 * - `LspService` drops a diagnostic batch whose `version` is behind the
 *   buffer's revision. The field is optional in the protocol. Whether tsserver
 *   actually sends it decides whether that check ever does anything.
 *   `reports whether it versions its diagnostics` records the real answer.
 * - Document sync sends whole documents. This confirms a real server accepts
 *   that and reports against it correctly.
 *
 * Slower than the rest of the file by design. If it turns flaky in CI, gate it
 * behind an env var rather than delete it — the coverage is not replaceable.
 */

/**
 * The server's own entry point, run under this Node.
 *
 * Not the `typescript-language-server` shim on PATH: on Windows that is a
 * `.cmd`, which needs a shell to launch, and a shell re-splits the command on
 * spaces. Naming the JS directly keeps the test about Nox rather than about
 * process launching — and the launching itself is `lsp.rs`'s problem, which
 * this cannot exercise anyway.
 */
const SERVER = process.execPath;
const SERVER_ARGS = [
  join(process.cwd(), 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
  '--stdio',
];

/** A genuine error: TS2322, assigning a string to a number. */
const SOURCE = 'const answer: number = "forty-two";\nexport default answer;\n';

let workspace: string;
let filePath: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nox-lsp-'));
  filePath = join(workspace, 'main.ts');
  await writeFile(filePath, SOURCE, 'utf8');
  // Without one, tsserver infers a project per file and its diagnostics get
  // less predictable — this keeps the test about Nox rather than about
  // TypeScript's project discovery.
  await writeFile(
    join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    'utf8',
  );
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

interface Published {
  uri: string;
  version?: number;
  diagnostics: {
    range: { start: { line: number; character: number } };
    severity?: number;
    message: string;
  }[];
}

/** Start a session, open the file, and wait for the server's verdict on it. */
async function diagnose(): Promise<{ session: LspSession; published: Published }> {
  const session = new LspSession(
    () => spawnLanguageServer(SERVER, SERVER_ARGS, { cwd: workspace }),
    { name: 'typescript-language-server', rootUri: pathToUri(workspace), timeoutMs: 30_000 },
  );

  const batches: Published[] = [];
  session.onNotification('textDocument/publishDiagnostics', (params) => {
    batches.push(params as Published);
  });

  await session.start();
  expect(session.status.get(), `stderr: ${session.stderr.join(' | ')}`).toBe('running');

  await session.notify('textDocument/didOpen', {
    textDocument: {
      uri: pathToUri(filePath),
      languageId: 'typescript',
      version: 1,
      text: SOURCE,
    },
  });

  // tsserver publishes an empty batch first and fills it in once the project
  // has loaded, so waiting for "a batch" would race the real answer.
  await expect
    .poll(() => batches.find((batch) => batch.diagnostics.length > 0), { timeout: 60_000 })
    .toBeDefined();

  return { session, published: batches.find((batch) => batch.diagnostics.length > 0)! };
}

describe('a real typescript-language-server', () => {
  it('completes the handshake and says what it can do', async () => {
    const session = new LspSession(
      () => spawnLanguageServer(SERVER, SERVER_ARGS, { cwd: workspace }),
      { name: 'typescript-language-server', rootUri: pathToUri(workspace), timeoutMs: 30_000 },
    );

    await session.start();
    const status = session.status.get();
    const capabilities = session.capabilities.get();
    await session.stop();

    expect(status, `stderr: ${session.stderr.join(' | ')}`).toBe('running');
    // Read, never assumed — `documents.ts` sends full text regardless, but the
    // session is supposed to record what it was told.
    expect(capabilities).toHaveProperty('textDocumentSync');
  }, 90_000);

  it('reports the error on the line that has it', async () => {
    const { session, published } = await diagnose();
    await session.stop();

    expect(published.uri).toBe(pathToUri(filePath));
    const first = published.diagnostics[0]!;
    // Zero-based on the wire; the error is on the first line.
    expect(first.range.start.line).toBe(0);
    expect(first.severity).toBe(1);
    expect(first.message).toMatch(/not assignable/i);
  }, 90_000);

  it('addresses the file by the URI Nox generates for it', async () => {
    // The whole diagnostics store is keyed by URI, so a server that spelled it
    // differently would file every diagnostic under a key nothing looks up —
    // and on Windows, where the drive letter is percent-encoded, that is a
    // real possibility rather than a theoretical one.
    const { session, published } = await diagnose();
    await session.stop();

    expect(published.uri).toBe(pathToUri(filePath));
  }, 90_000);

  it('does not version its diagnostics, so the staleness check never fires here', async () => {
    const { session, published } = await diagnose();
    await session.stop();

    // The real answer, recorded so it is visible rather than assumed.
    // `publishDiagnostics.version` is optional and tsserver omits it, which
    // means `LspService`'s stale-batch check is dead code for this server —
    // and the range clamp in `editor/lsp.ts` is the *only* thing standing
    // between a batch computed against older text and an out-of-range
    // position, which CodeMirror throws on. Kept as an assertion rather than a
    // comment so that a future tsserver starting to send it is a test failure
    // someone reads, not a silent change in which safeguard is load-bearing.
    expect(published.version).toBeUndefined();
  }, 90_000);

  it('asks for incremental sync, and accepts the whole document anyway', async () => {
    // The risky path, and the one worth proving. tsserver advertises
    // textDocumentSync 2 (incremental) while `documents.ts` deliberately sends
    // full text — a change event with no `range` is a whole-document
    // replacement per the protocol, but "per the protocol" and "this server
    // does it" are different claims, and only one of them can be tested.
    const { session, published } = await diagnose();
    expect(session.capabilities.get()?.textDocumentSync).toBe(2);
    expect(published.diagnostics).toHaveLength(1);

    const fixed = 'const answer: number = 42;\nexport default answer;\n';
    const after: Published[] = [];
    session.onNotification('textDocument/publishDiagnostics', (params) => {
      after.push(params as Published);
    });

    await session.notify('textDocument/didChange', {
      textDocument: { uri: pathToUri(filePath), version: 2 },
      contentChanges: [{ text: fixed }],
    });

    // The error is gone in the new text, so a server that understood the
    // change clears it. One that ignored a full-text update would keep
    // reporting an error the user has already fixed.
    //
    // Matched on the URI as well as the count: tsserver publishes for other
    // files in the project too, and an empty batch for one of *those* would
    // satisfy a count-only check while proving nothing about our document.
    await expect
      .poll(
        () =>
          after.find(
            (batch) => batch.uri === pathToUri(filePath) && batch.diagnostics.length === 0,
          ),
        { timeout: 60_000 },
      )
      .toBeDefined();

    await session.stop();
  }, 90_000);
});

describe('completion from a real typescript-language-server', () => {
  /**
   * The test that can contradict the design. Its predecessor found that
   * tsserver sends no `version` on diagnostics, which turned a safeguard
   * into dead code; the equivalent assumption here is that a bare member
   * access returns anything useful at all.
   */
  it('offers members after a dot', async () => {
    const session = new LspSession(
      () => spawnLanguageServer(SERVER, SERVER_ARGS, { cwd: workspace }),
      { name: 'typescript-language-server', rootUri: pathToUri(workspace), timeoutMs: 30_000 },
    );

    await session.start();
    expect(session.status.get(), `stderr: ${session.stderr.join(' | ')}`).toBe('running');

    const source = 'const s = "abc";\ns.\n';
    await session.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToUri(filePath),
        languageId: 'typescript',
        version: 1,
        text: source,
      },
    });

    const response = await session.request<{
      items?: { label: string; kind?: number }[];
      isIncomplete?: boolean;
    }>('textDocument/completion', {
      textDocument: { uri: pathToUri(filePath) },
      // Line 1, just after the dot.
      position: { line: 1, character: 2 },
    });

    const items = Array.isArray(response) ? response : (response.items ?? []);
    const labels = items.map((item) => item.label);
    await session.stop();

    expect(items.length).toBeGreaterThan(0);
    // A string has these; if they are missing, the assumption that a bare
    // member access is useful was wrong, and the design needs to know.
    expect(labels).toContain('toUpperCase');
    expect(items.find((item) => item.label === 'toUpperCase')?.kind).toBeDefined();
  }, 90_000);

  it('reports whether its completion items carry their own documentation', async () => {
    // Recorded rather than required. If they do, the lazy resolve path is
    // dead weight; if they do not, it is the only way to show a tooltip.
    const session = new LspSession(
      () => spawnLanguageServer(SERVER, SERVER_ARGS, { cwd: workspace }),
      { name: 'typescript-language-server', rootUri: pathToUri(workspace), timeoutMs: 30_000 },
    );

    await session.start();
    const source = 'const s = "abc";\ns.\n';
    await session.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToUri(filePath),
        languageId: 'typescript',
        version: 1,
        text: source,
      },
    });

    const response = await session.request<{ items?: { documentation?: unknown }[] }>(
      'textDocument/completion',
      {
        textDocument: { uri: pathToUri(filePath) },
        position: { line: 1, character: 2 },
      },
    );

    const items = Array.isArray(response) ? response : (response.items ?? []);
    const withDocs = items.filter((item) => item.documentation !== undefined);
    await session.stop();

    // The measured answer: none of them carry documentation, which is what
    // makes `completionItem/resolve` load-bearing rather than optional.
    expect(withDocs).toHaveLength(0);
  }, 90_000);
});
