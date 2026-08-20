/**
 * Disambiguating labels for the tab strip.
 *
 * Two open `index.ts` tabs are indistinguishable by name alone, so when two
 * or more buffers share a name the label becomes `name — parent`, where the
 * parent is the *shortest* distinguishing ancestor directory: walk the
 * colliding paths' directory chains upward in lockstep, nearest parent
 * first, and use the first level at which every buffer's directory name is
 * unique (VS Code's rule). `app1/src/index.ts` beside `app2/src/index.ts`
 * therefore reads `index.ts — app1`, not `index.ts — src`.
 *
 * When no single level tells all of them apart (one path is a suffix of
 * another, or a chain runs out first), the full parent directory is the
 * label — always distinct, since two buffers cannot hold the same path.
 * Untitled/pathless buffers keep their bare name.
 *
 * Pure — no DOM, no services (see the layering table in CLAUDE.md).
 */
import { dirname } from './path';

const SEP_RE = /[\\/]/;

interface Labelable {
  id: string;
  name: string;
  path: string | null;
}

/** Ancestor directory names of `path`, nearest parent first. */
function ancestry(path: string): string[] {
  return dirname(path).split(SEP_RE).filter(Boolean).reverse();
}

/** Buffer id → the label the tab strip should show for it. */
export function tabLabels(buffers: readonly Labelable[]): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, Labelable[]>();
  for (const buffer of buffers) {
    labels.set(buffer.id, buffer.name);
    const group = byName.get(buffer.name);
    if (group) group.push(buffer);
    else byName.set(buffer.name, [buffer]);
  }

  for (const group of byName.values()) {
    // Pathless members keep their bare name; with fewer than two located
    // buffers there is no location contrast worth printing.
    const pathed = group.filter((buffer) => buffer.path !== null);
    if (pathed.length < 2) continue;

    const chains = pathed.map((buffer) => ancestry(buffer.path ?? ''));

    // Walk up until every colliding buffer's directory name is unique.
    let level = -1;
    const depth = Math.min(...chains.map((chain) => chain.length));
    for (let k = 0; k < depth; k++) {
      const names = chains.map((chain) => chain[k] ?? '');
      if (new Set(names).size === names.length) {
        level = k;
        break;
      }
    }

    pathed.forEach((buffer, i) => {
      const suffix = level >= 0 ? chains[i]?.[level] : dirname(buffer.path ?? '');
      if (suffix) labels.set(buffer.id, `${buffer.name} — ${suffix}`);
    });
  }

  return labels;
}
