const korean = /[가-힣]/;

function withoutLeadingLabels(title: string): string {
  let remaining = title.trim();
  while (remaining.startsWith("[") || remaining.startsWith("(")) {
    const closing: string[] = [];
    let end = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const character = remaining[i];
      if (character === "[") closing.push("]");
      else if (character === "(") closing.push(")");
      else if (character === "]" || character === ")") {
        if (closing.pop() !== character) break;
        if (!closing.length) { end = i + 1; break; }
      }
    }
    if (end < 0) break;
    remaining = remaining.slice(end).trimStart();
  }
  return remaining;
}

/** Presentation only: never change provider titles or duplicate matching keys. */
export function catalogDisplayTitle(title: string): string {
  const withoutLabels = withoutLeadingLabels(title);
  const plain = withoutLabels
    .replace(/(?:\s*(?:\[[^\]]*\]|\([^가-힣)]*\)))+\s*$/, "")
    .trim();
  const parts = plain.split(/\s*[|｜]\s*/);
  const translated = parts.find((part) => korean.test(part));
  if (!translated) return withoutLabels || title;
  // Delimited translations may deliberately start with Latin abbreviations.
  if (parts.length > 1) return translated.trim();
  const start = translated.search(korean);
  const numberPrefix = translated.slice(0, start).match(/\d+\s*$/)?.[0] ?? "";
  return translated.slice(start - numberPrefix.length).trim();
}
