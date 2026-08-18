import type { LanguageServerProcess } from '../../src/platform/types';

/**
 * Adapts a real child process to `LanguageServerProcess`.
 *
 * This is what `src-tauri/src/lsp.rs` does, in about the same number of lines,
 * and standing it up here means the wire format and the whole client are
 * exercised against genuine pipes — everything except the Rust plumbing
 * itself, which cannot run without a window.
 *
 * The reader is byte-based rather than line-based, which is the one thing that
 * could not be copied from `tests/stdio.test.ts`: an LSP body has no trailing
 * newline, so `readline` would hold every message until the next one arrived.
 * `Content-Length` is a byte count, so the buffer stays a `Buffer` — slicing a
 * decoded string would cut in the wrong place on the first accented character.
 */
export async function spawnLanguageServer(
  command: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): Promise<LanguageServerProcess> {
  const { spawn } = await import('node:child_process');

  // No shell. A shell would re-split the command on spaces, and `node` lives
  // under `C:\Program Files` on Windows — which fails as `'C:\Program' is not
  // recognized` rather than as anything that names the real problem. Callers
  // pass an executable and an entry point instead of relying on PATH.
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
  });

  const messages: ((message: string) => void)[] = [];
  const stderr: ((line: string) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];
  const bufferedMessages: string[] = [];
  const bufferedStderr: string[] = [];
  let exited: { code: number | null } | null = null;
  let buffer = Buffer.alloc(0);

  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const split = buffer.indexOf('\r\n\r\n');
      if (split === -1) return;

      const header = buffer.subarray(0, split).toString('ascii');
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) return;
      if (buffer.length < split + 4 + length) return;

      const message = buffer.subarray(split + 4, split + 4 + length).toString('utf8');
      buffer = buffer.subarray(split + 4 + length);

      if (messages.length === 0) bufferedMessages.push(message);
      else for (const handler of messages) handler(message);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trimEnd();
    if (stderr.length === 0) bufferedStderr.push(line);
    else for (const handler of stderr) handler(line);
  });

  child.on('exit', (code: number | null) => {
    exited = { code };
    for (const handler of exits) handler(code);
  });

  // A write racing the child's own exit fails asynchronously, and an unhandled
  // 'error' on a stream is an uncaught exception rather than a rejected
  // promise. `exit` is precisely such a write — the server acts on it by dying
  // — so this is the normal path, not a defensive one.
  child.stdin.on('error', () => {});

  return {
    send: async (message: string) => {
      if (exited || child.stdin.destroyed) return;
      const body = Buffer.from(message, 'utf8');
      // One write, not two: a header and a body written separately can be
      // interleaved with the exit and leave half a message on the wire.
      child.stdin.write(
        Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]),
      );
    },
    onMessage: (handler) => {
      messages.push(handler);
      for (const message of bufferedMessages.splice(0)) handler(message);
    },
    onStderr: (handler) => {
      stderr.push(handler);
      for (const line of bufferedStderr.splice(0)) handler(line);
    },
    onExit: (handler) => {
      exits.push(handler);
      if (exited) handler(exited.code);
    },
    kill: async () => {
      child.kill();
    },
  };
}
