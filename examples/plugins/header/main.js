/**
 * The reference plugin: a worker, in about sixty lines.
 *
 * Copy this folder into `<config>/plugins/` and run **Reload Plugins**. Its
 * command appears in the palette as "Header: Insert File Header".
 *
 * What it demonstrates is the whole shape of the contract:
 *
 * 1. **Greet first.** Nox will not send anything until a `hello` naming a
 *    protocol version it speaks, and gives up on a plugin that never does.
 * 2. **Read through `context.*`.** Nothing here is a live handle; everything
 *    is serialisable, and every read is recorded against this plugin.
 * 3. **Never write.** There is no verb for it. This stages a *proposal*, which
 *    lands in the review panel and becomes a write only when the user clicks
 *    Apply. The other route to an effect is `command.execute`, and that goes
 *    through the same permission check the palette does.
 * 4. **Answer the invoke.** Nox is waiting on the id it sent, and a plugin
 *    that never replies is a plugin that gets timed out and eventually
 *    disabled.
 *
 * `globalThis.nox` is the two-function shim the worker transport wraps this
 * file in — `send` writes one message, `onRequest` receives one.
 */

const PROTOCOL_VERSION = 1;

/** Correlation ids for the questions this plugin asks Nox. */
let nextId = 1;

/** Questions in flight, so an answer can be matched to the thing that asked. */
const waiting = new Map();

/** Ask Nox something and wait for the answer. */
function ask(method, params) {
  const id = nextId++;
  nox.send(params === undefined ? { id, method } : { id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

/**
 * Fill the panel this plugin declared.
 *
 * Note what did *not* have to happen for the panel's button to exist: this
 * plugin was not running. The button comes from `plugin.json`, and opening it
 * is what started the plugin and produced this call — which is why a plugin
 * with a panel stays as lazy as one with only commands.
 *
 * There is no subscription here and there cannot be. Nox pushes no editor
 * events, so this list is accurate as of the moment the panel was opened and
 * does not follow along afterwards.
 */
async function fillBuffers() {
  const buffers = await ask('context.openBuffers');

  nox.send({
    id: 0,
    method: 'panel.set',
    params: {
      name: 'buffers',
      rows: (buffers.result ?? []).map((buffer) => ({
        text: buffer.name,
        detail: buffer.languageName,
        // A row can carry a command and an argument. This one runs this
        // plugin's own contributed command; it could name any command in Nox,
        // and it would be checked against this plugin's permissions like
        // everything else it can reach.
        command: 'plugin.header.insert',
      })),
    },
  });
}

nox.onRequest(async (message) => {
  // An answer to something this plugin asked.
  if ('ok' in message) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }

  if (message.method === 'panel.show') {
    await fillBuffers();
    nox.send({ id: message.id, ok: true });
    return;
  }

  if (message.method !== 'command.invoke') return;
  if (message.params.name !== 'insert') {
    nox.send({
      id: message.id,
      ok: false,
      error: { code: 'unknown-method', message: `no command "${message.params.name}"` },
    });
    return;
  }

  const buffers = await ask('context.openBuffers');
  const target = (buffers.result ?? [])[0];
  if (!target) {
    // Answering `ok` with nothing done is the honest reply: the command ran,
    // and there was nothing to run it on.
    nox.send({ id: message.id, ok: true });
    return;
  }

  const staged = await ask('proposal.stage', {
    description: `Insert a header into ${target.name}`,
    edits: [{ bufferId: target.id, changes: { from: 0, to: 0, insert: `// ${target.name}\n` } }],
    // The revision the offsets above were computed against. Declaring it is
    // what makes a stale edit a refusal instead of silent corruption — the
    // buffer may have moved between the read and this message.
    baseRevisions: { [target.id]: target.revision },
  });

  nox.send({ id: message.id, ok: staged.ok, ...(staged.ok ? {} : { error: staged.error })});
});

// Last, not first: everything above must be listening before Nox is told this
// plugin is ready to be asked anything.
nox.send({ id: 0, method: 'hello', params: { version: PROTOCOL_VERSION, label: 'Header' } });
