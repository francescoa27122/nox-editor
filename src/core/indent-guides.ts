/**
 * How many indent guides each line gets.
 *
 * A guide is a hairline at each indent stop to the left of a line's text, so
 * a line indented two levels gets two: one at column zero and one at the
 * first stop. The count is the line's leading width in units, rounded down,
 * because a guide drawn inside the text is worse than one missing.
 *
 * A blank line has no indentation of its own and takes the shallower of its
 * neighbours: inside a block it keeps the block's guides so the column does
 * not flicker off between two lines that share it, and between two blocks it
 * takes the outer one so a guide never appears where neither neighbour has
 * it. A missing neighbour counts as depth zero, which is what keeps the last
 * blank line of a file clean.
 *
 * Pure and linear in the text it is given: `editor/indent-guides.ts` hands it
 * the visible lines on every viewport change, so this is on the typing path
 * and `tests/indent-guides.test.ts` holds its growth.
 */
export function guideDepths(lines: readonly string[], unit: number): number[] {
  const step = Math.max(1, unit);
  const depths: number[] = new Array<number>(lines.length);
  const blank: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let width = 0;
    let j = 0;
    for (; j < line.length; j++) {
      const ch = line.charCodeAt(j);
      if (ch === 0x20) width++;
      else if (ch === 0x09) width += step - (width % step);
      else break;
    }
    if (j === line.length) {
      // Wholly blank, resolved once the neighbours are known.
      blank.push(i);
      depths[i] = 0;
    } else {
      depths[i] = Math.floor(width / step);
    }
  }

  // Blank runs take the shallower of the non-blank lines on either side.
  // Scanning outward from each blank line is bounded by the run's length,
  // so a run of `k` blank lines costs `k` per line: quadratic in the run,
  // never in the document, and runs are short in real text.
  for (const i of blank) {
    let above = i - 1;
    while (above >= 0 && isBlank(lines[above] ?? '')) above--;
    let below = i + 1;
    while (below < lines.length && isBlank(lines[below] ?? '')) below++;
    const up = above >= 0 ? (depths[above] ?? 0) : 0;
    const down = below < lines.length ? (depths[below] ?? 0) : 0;
    depths[i] = Math.min(up, down);
  }

  return depths;
}

function isBlank(line: string): boolean {
  for (let j = 0; j < line.length; j++) {
    const ch = line.charCodeAt(j);
    if (ch !== 0x20 && ch !== 0x09) return false;
  }
  return true;
}
