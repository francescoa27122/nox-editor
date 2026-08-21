/**
 * A stand-in orchestrator for `examples/orchestrator-agent.mjs`.
 *
 * Deliberately not a model: the adapter is what is under test, so the brain
 * has to be the one part that cannot vary between runs. It reads the active
 * buffer over the pipe — which is the read path the adapter exists to
 * mediate — and proposes one line at the end of it.
 */
export default async function think(instruction, context, opened, read) {
  const target = opened.find((buffer) => buffer.isActive) ?? opened[0];
  if (!target) return { edits: [], summary: 'Nothing is open.' };

  // Offset from the text this orchestrator actually read, not from the
  // listing's `length`. The adapter declares the listing's revision, so the
  // two agree — and if they ever stopped agreeing, the staged edit would land
  // somewhere nobody looked.
  const text = await read('context.bufferText', { bufferId: target.id });

  return {
    description: `Append a marker to ${target.name}`,
    edits: [
      {
        bufferId: target.id,
        changes: { from: text.length, to: text.length, insert: '// seen\n' },
      },
    ],
    summary: `Proposed one line at the end of ${target.name}.`,
  };
}
