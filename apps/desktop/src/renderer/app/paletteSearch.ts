export function scorePaletteMatch(value: string, rawQuery: string): number {
  const query = rawQuery.trim().startsWith('>') ? rawQuery.trim().slice(1).trim() : rawQuery.trim();
  if (!query) return 1;
  const words = value.toLocaleLowerCase().split(/\s+/);
  const terms = query.toLocaleLowerCase().split(/\s+/);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const word of words) {
      const coverage = term.length / word.length;
      if (word === term) best = 1;
      else if (word.startsWith(term)) best = Math.max(best, 0.75 + coverage * 0.25);
      else if (word.includes(term)) best = Math.max(best, 0.5 + coverage * 0.25);
      else {
        let cursor = 0;
        for (const character of word) if (character === term[cursor]) cursor++;
        if (cursor === term.length) best = Math.max(best, 0.25 + coverage * 0.25);
      }
    }
    if (!best) return 0;
    total += best;
  }
  return total / terms.length;
}
