/**
 * How a function's cost grows with its input, measured well enough to run on
 * a shared CI runner without being flaky.
 *
 * The production-readiness plan (§4) says: *"Do not gate CI on wall-clock.
 * Shared runners are too noisy for that to mean anything."* That is right, and
 * it is why this measures a **ratio** rather than a duration. A GitHub runner
 * can be three times slower than this laptop and the ratio is unchanged,
 * because both halves of it move together. What survives that division is the
 * exponent — the one property the plan actually names as the risk: *"These are
 * where an accidental O(n²) actually lands."*
 *
 * Three techniques do the noise work, and the third was not optional:
 *
 * - **Minimum, not mean.** Scheduler preemption, GC and a neighbouring job on
 *   the same runner can only ever make a sample *slower*. The fastest of `k`
 *   samples is therefore the least contaminated, and a minimum makes one
 *   unlucky sample cost nothing instead of dragging an average.
 * - **Warm-up before measuring.** The first calls run in the interpreter and
 *   are several times slower than optimised code. Timing those would measure
 *   the JIT's schedule rather than the algorithm.
 * - **Enough work per sample to be worth timing.** The first version of this
 *   file timed a single call, and the small side of four of the six guards
 *   came out between **0.02 ms and 0.32 ms**. At twenty microseconds a
 *   measurement is scheduler jitter with an algorithm somewhere inside it, and
 *   the cost is dominated by call and allocation overhead that is identical at
 *   both sizes — which *flattens* the ratio and would hide the regression this
 *   exists to catch. `calibrate` below fixes that by finding how many
 *   iterations it takes to reach a floor, and timing that many.
 */

/** Each timed block runs for at least this long. See the third note above. */
const TARGET_MS = 8;

/** How the cost at `large` compares with the cost at `small`. */
export interface Growth {
  /** `time(large) / time(small)`. */
  ratio: number;
  /** `large / small` — what the ratio would be if the cost were exactly linear. */
  linear: number;
  smallMs: number;
  largeMs: number;
  /** Calls per timed block, chosen by `calibrate`. Reported so a surprising number is visible. */
  iterations: number;
}

export interface GrowthOptions {
  /** Samples per size. The fastest is kept. */
  samples?: number;
  /** Untimed calls per size before sampling, to let the JIT settle. */
  warmup?: number;
}

/** Milliseconds to run `run` exactly `iterations` times. */
function time(run: () => void, iterations: number): number {
  const started = performance.now();
  for (let i = 0; i < iterations; i++) run();
  return performance.now() - started;
}

/**
 * How many calls it takes to fill `TARGET_MS`.
 *
 * Calibrated on the **small** input and then used for both, because the
 * iteration count has to be identical on the two sides or it multiplies into
 * the ratio and makes it meaningless. A slow runner arrives at a smaller
 * number by itself, which is the point of measuring rather than hardcoding.
 *
 * The result only sets how long the measurement takes; getting it wrong costs
 * time, never correctness.
 */
function calibrate(run: () => void): number {
  let iterations = 1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const elapsed = time(run, iterations);
    if (elapsed >= TARGET_MS) return iterations;
    // Guard the ratio against a zero reading on a coarse clock, and grow by at
    // least 2x so a function far below the floor still converges quickly.
    const growth = Math.max(2, TARGET_MS / Math.max(elapsed, 0.001));
    iterations = Math.min(Math.ceil(iterations * growth), 5_000_000);
  }
  return iterations;
}

/**
 * Measure `run` at two input sizes and report how the cost grew.
 *
 * `prepare` builds the input *outside* the timed region: generating a corpus
 * is linear in its size, so including it would add a linear term to whatever
 * is being measured and pull every ratio toward `linear` — flattering a
 * quadratic implementation into looking almost linear, which is the exact
 * failure this must not have.
 */
export function growth<T>(
  prepare: (size: number) => T,
  run: (input: T) => void,
  small: number,
  large: number,
  options: GrowthOptions = {},
): Growth {
  const { samples = 5, warmup = 3 } = options;

  const smallInput = prepare(small);
  const largeInput = prepare(large);
  const runSmall = () => run(smallInput);
  const runLarge = () => run(largeInput);

  for (let i = 0; i < warmup; i++) {
    runSmall();
    runLarge();
  }

  const iterations = calibrate(runSmall);

  // Interleaved rather than all-of-small-then-all-of-large. A runner that
  // slows down partway through — a noisy neighbour arriving, a thermal
  // throttle — would otherwise put all of one size on one side of the change
  // and corrupt the ratio in whichever direction the drift happened to go.
  // Alternating means a drift lands on both sizes and mostly divides out.
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let i = 0; i < samples; i++) {
    smallMs = Math.min(smallMs, time(runSmall, iterations));
    largeMs = Math.min(largeMs, time(runLarge, iterations));
  }

  return { ratio: largeMs / smallMs, linear: large / small, smallMs, largeMs, iterations };
}

/**
 * A readable failure message. A bare `expected 19.4 to be less than 24` in CI
 * gives a reader nothing to act on; this says what grew, by how much, against
 * what linear and quadratic would each have looked like.
 */
export function describeGrowth(label: string, g: Growth, budget: number): string {
  return [
    `${label}: ${g.ratio.toFixed(1)}x slower for ${g.linear}x the input`,
    `(budget ${budget}x; linear ~${g.linear}x, quadratic ~${g.linear ** 2}x)`,
    `[${g.smallMs.toFixed(2)}ms -> ${g.largeMs.toFixed(2)}ms over ${g.iterations} iterations]`,
  ].join(' ');
}
