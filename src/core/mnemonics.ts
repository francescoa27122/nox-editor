/**
 * The Alt letter each menu title gets.
 *
 * Windows and Linux open a menu with Alt and a letter, and the letter is
 * drawn underlined in the title while Alt is held. Which letter is a decision
 * about the whole bar, not about one title: "Find" cannot take F once "File"
 * has, so it takes the first letter in its own word that is still free, which
 * is what keeps the underline inside the word a person is reading.
 *
 * Pure, so `tests/mnemonics.test.ts` can pin the assignment over the real
 * menu table without mounting anything. A title with no free letter gets
 * `null` rather than a made-up key: an underline under a letter the title
 * does not contain is worse than no underline.
 */
export function mnemonicsFor(labels: readonly string[]): (string | null)[] {
  const taken = new Set<string>();
  return labels.map((label) => {
    for (const char of label) {
      const letter = char.toUpperCase();
      if (letter < 'A' || letter > 'Z' || taken.has(letter)) continue;
      taken.add(letter);
      return letter;
    }
    return null;
  });
}
