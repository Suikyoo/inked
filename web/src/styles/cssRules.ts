/**
 * Test helper for reading stylesheets imported with `?raw`. Not imported by app code.
 * Line endings, comments and whitespace runs are normalised, so checks hold on CRLF checkouts
 * and whatever the formatter does with spacing.
 */
export function normaliseCss(css: string): string {
  return css
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .trim();
}

const selectorKey = (s: string) =>
  s
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .join(',');

/** Every selector in the sheet, one entry per comma-separated part, in source order. */
export function cssSelectors(css: string): string[] {
  return [...normaliseCss(css).matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => selectorKey(m[1]).split(','));
}

/**
 * Declaration blocks of every rule whose selector list is exactly `selector` (comma-separated
 * lists compared part by part), in source order, including rules nested in at-rules.
 * Each block is normalised: `prop:value;prop:value`.
 */
export function cssRules(css: string, selector: string): string[] {
  const want = selectorKey(selector);
  const out: string[] = [];
  for (const m of normaliseCss(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorKey(m[1]) === want) out.push(m[2]);
  }
  return out;
}
