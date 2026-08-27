/**
 * A status item, and the one thing to understand about them.
 *
 * Copy this folder into `<config>/plugins/` and run **Reload Plugins**. A
 * readout appears at the left of the status bar; clicking it runs this
 * plugin's own command, which changes what it says.
 *
 * **`"activation": "startup"` is not optional here.** A command can wake a
 * lazy plugin, but a status item cannot — its content is only known to running
 * code, so a plugin that has never run has nothing to show. Declaring it in
 * the manifest is what makes the cost visible to whoever installs this.
 *
 * **Nox pushes no events to plugins.** There is no "the buffer changed" or
 * "the selection moved" message, by design — a plugin woken on every keystroke
 * is the thing the whole out-of-process architecture exists to prevent. So an
 * item changes when *this plugin* does something: at startup, when one of its
 * commands runs, or on a timer it owns. A readout that has to track the editor
 * live is not something this API can do yet, and pretending otherwise would
 * produce one that is quietly stale.
 */

const PROTOCOL_VERSION = 1;

let bumps = 0;

/** Redraw the item. Set is idempotent — the same text twice costs nothing. */
function render() {
  nox.send({
    id: 0,
    method: 'status.set',
    params: {
      name: 'count',
      text: bumps === 0 ? 'Counter' : `Counter · ${bumps}`,
      tooltip: 'Click to bump. From the counter plugin.',
      // Its own contributed command, namespaced the way Nox registered it.
      command: 'plugin.counter.bump',
    },
  });
}

nox.onRequest((message) => {
  // Replies to the `status.set` calls above. Nothing here waits on one, but
  // they still have to be recognised rather than treated as requests.
  if ('ok' in message) return;

  if (message.method === 'command.invoke' && message.params.name === 'bump') {
    bumps += 1;
    render();
    nox.send({ id: message.id, ok: true });
    return;
  }

  nox.send({
    id: message.id,
    ok: false,
    error: { code: 'unknown-method', message: `no command "${message.params?.name}"` },
  });
});

// Greet, then draw. Nox ignores everything until the greeting is accepted, so
// a `status.set` before this one would be answered into a session that has not
// started yet.
nox.send({ id: 0, method: 'hello', params: { version: PROTOCOL_VERSION, label: 'Counter' } });
render();
