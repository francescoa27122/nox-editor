/**
 * Decorations: marks in the editor, and the one event a plugin gets.
 *
 * Copy this folder into `<config>/plugins/` and run **Reload Plugins**. Then
 * open a file with a `TODO` in it and run **TODOs: Mark TODOs in This File**.
 * Each `TODO` gets a wavy underline; hover one for the message.
 *
 * **A plugin does not choose how a mark looks.** It picks a `kind` — `error`,
 * `warning`, `info` or `highlight` — and Nox decides what that is drawn as.
 * The same split makes panels rows rather than markup: a plugin says what it
 * *means*, and the editor stays the editor's.
 *
 * **Then the interesting part.** Once a plugin has decorated a buffer, Nox
 * sends `document.changed` for that buffer — debounced, after the typing
 * stops, and only for buffers this plugin has already decorated. It is the
 * only event a plugin gets, and it is deliberately not a keystroke feed: a
 * plugin woken on every character is the thing out-of-process exists to
 * prevent. So the loop is: decorate, get told it changed, decorate again.
 *
 * Offsets are into the buffer's text, and they can go stale between reading
 * and sending. Nox clamps anything past the end rather than throwing, and
 * carries existing marks forward through edits, so a mark stays over its text
 * while you type and is corrected on the next pass.
 *
 * **And what it is configured with.** The three options in `plugin.json` are
 * declared rather than registered, so they appear in Settings → Plugins before
 * this file has ever run. Two rules follow from that and both are visible
 * below: the plugin asks for its values with `settings.get` when it starts,
 * and Nox pushes `settings.changed` — *with the new values* — when the user
 * moves a control. Changing a setting never starts a plugin that was idle.
 */

const PROTOCOL_VERSION = 1;

let nextId = 1;
const waiting = new Map();

/**
 * Filled by `settings.get` before the first scan, and replaced wholesale on
 * every `settings.changed`. The defaults here are only a stand-in for the
 * moment before the first answer arrives — the real ones live in
 * `plugin.json`, which is the single place they are written.
 */
let settings = { markers: 'TODO, FIXME, XXX', kind: 'warning', limit: 200 };

/** Buffers this plugin has marked, so a settings change can redo them. */
const decorated = new Set();

/**
 * The user's markers as one pattern.
 *
 * Escaped, because these words come from a text box: a stray `(` would
 * otherwise be a syntax error that stops the plugin rather than a marker
 * nobody matches.
 */
function markerPattern() {
  const words = settings.markers
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  return words.length === 0 ? null : new RegExp(words.join('|'), 'g');
}

function ask(method, params) {
  const id = nextId++;
  nox.send(params === undefined ? { id, method } : { id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

/** Find the markers in one buffer and ask for a mark over each. */
async function markTodos(bufferId) {
  const answer = await ask('context.bufferText', { bufferId });
  const text = answer.ok ? answer.result : '';

  const ranges = [];
  const pattern = markerPattern();
  if (pattern !== null) {
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (ranges.length >= settings.limit) break;
      ranges.push({
        from: match.index,
        to: match.index + match[0].length,
        kind: settings.kind,
        message: `${match[0]} left in the code`,
      });
    }
  }

  // An empty list is how a plugin takes its own marks back, so this both
  // adds and clears without needing two paths — including the case where the
  // user emptied the Markers box, which should remove the marks rather than
  // leave the last set frozen on screen.
  decorated.add(bufferId);
  await ask('editor.decorate', { bufferId, ranges });
}

/** The buffer the user is looking at, or null. */
async function activeBuffer() {
  const answer = await ask('context.openBuffers');
  return (answer.result ?? [])[0]?.id ?? null;
}

nox.onRequest(async (message) => {
  if ('ok' in message) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }

  // The buffer changed and has been quiet since. Re-scan it, which is what
  // keeps the marks true rather than merely carried forward.
  if (message.method === 'document.changed') {
    await markTodos(message.params.bufferId);
    nox.send({ id: message.id, ok: true });
    return;
  }

  // The values, not a nudge — so there is nothing to fetch before redrawing.
  if (message.method === 'settings.changed') {
    settings = message.params.values;
    nox.send({ id: message.id, ok: true });
    for (const bufferId of decorated) await markTodos(bufferId);
    return;
  }

  if (message.method === 'command.invoke' && message.params.name === 'mark') {
    const bufferId = await activeBuffer();
    if (bufferId) await markTodos(bufferId);
    nox.send({ id: message.id, ok: true });
    return;
  }

  nox.send({
    id: message.id,
    ok: false,
    error: { code: 'unknown-method', message: 'not something this plugin does' },
  });
});

nox.send({ id: 0, method: 'hello', params: { version: PROTOCOL_VERSION, label: 'TODOs' } });

// After the greeting, because everything else is refused until Nox has
// accepted the version. `settings.get` takes no arguments: the answer is
// always this plugin's own namespace, which is why there is no way to spell a
// request for someone else's.
void ask('settings.get').then((answer) => {
  if (answer.ok) settings = answer.result;
});
