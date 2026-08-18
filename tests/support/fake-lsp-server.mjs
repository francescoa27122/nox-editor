// A minimal language server, for tests. Speaks real Content-Length framing
// over real pipes, so the client is exercised against the wire format rather
// than against a helpful fake of it.
//
// The accented server name is the point: its byte length exceeds its character
// count, so a client that framed over decoded text would truncate it.

let buffer = Buffer.alloc(0);

function write(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  for (;;) {
    const split = buffer.indexOf('\r\n\r\n');
    if (split === -1) return;

    const header = buffer.subarray(0, split).toString('ascii');
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length)) {
      process.stderr.write('fake server: header with no length\n');
      process.exit(2);
    }
    if (buffer.length < split + 4 + length) return;

    const raw = buffer.subarray(split + 4, split + 4 + length).toString('utf8');
    buffer = buffer.subarray(split + 4 + length);

    const message = JSON.parse(raw);

    if (message.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1 },
          serverInfo: { name: 'café — naïve', version: '1.0' },
        },
      });
    }

    if (message.method === 'textDocument/didOpen') {
      // Push a diagnostic without being asked, which is what a real server
      // does and what the whole feature depends on.
      write({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1,
              message: 'não pode',
            },
          ],
        },
      });
    }

    if (message.method === 'shutdown') {
      write({ jsonrpc: '2.0', id: message.id, result: null });
    }

    if (message.method === 'exit') process.exit(0);
  }
});
