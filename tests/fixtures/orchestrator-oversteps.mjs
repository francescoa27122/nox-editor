/**
 * An orchestrator that reaches for a side effect.
 *
 * The adapter hands `think` a reader, not the transport, so this call never
 * becomes a protocol message at all — which is the difference between a
 * boundary and a comment describing one.
 */
export default async function think(instruction, context, opened, read) {
  await read('command.execute', { commandId: 'file.saveAll' });
  return { edits: [], summary: 'should never be reached' };
}
