/**
 * Catches promise rejections that nothing caught, for the length of one body.
 *
 * A fire-and-forget call — `void session.write(data)` — cannot be awaited, so
 * the only way to prove it is handled is to watch what the runtime does with a
 * promise nobody caught. In the app that reaches the `unhandledrejection`
 * backstop at `app.ts:686` and becomes a "Something went wrong" toast; under
 * Vitest's node environment it reaches `process`, and lands in the array this
 * returns.
 */
export async function unhandledRejections(
  body: () => void | Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };

  process.on('unhandledRejection', listener);
  try {
    await body();
    // Node decides a rejection is unhandled only after the microtask queue has
    // drained and a turn of the event loop has passed, so this has to wait on a
    // timer. Awaiting a microtask would see nothing and pass regardless.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', listener);
  }

  return seen;
}
