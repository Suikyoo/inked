const LINK = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;
const key = (t: string) => t.trim().toLowerCase();

/** Note ids the answer cites with [[Title]], in order of first appearance; titles that are not sources are dropped. */
export function parseCitations(answer: string, sources: readonly { noteId: string; title: string }[]): string[] {
  const byTitle = new Map<string, string>();
  for (const s of sources) if (!byTitle.has(key(s.title))) byTitle.set(key(s.title), s.noteId);
  const out: string[] = [];
  for (const m of answer.matchAll(LINK)) {
    const id = byTitle.get(key(m[1]));
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
