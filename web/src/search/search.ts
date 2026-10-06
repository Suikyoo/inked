import { fuzzyMatch, type FuzzyMatch } from './fuzzy';

export interface SearchEntry {
  noteId: string;
  vaultId: string;
  /** "vault / folder/path / title" */
  text: string;
  /** Index in `text` where the folder path (or title) starts, i.e. after "vault / ". */
  pathStart: number;
  /** Index in `text` where the title starts. */
  titleStart: number;
  updatedAt: string;
}

export function buildEntry(
  noteId: string,
  vaultId: string,
  vaultName: string,
  folderPath: readonly string[],
  title: string,
  updatedAt: string,
): SearchEntry {
  const head = vaultName + ' / ';
  const path = folderPath.length ? folderPath.join('/') + ' / ' : '';
  return {
    noteId,
    vaultId,
    text: head + path + title,
    pathStart: head.length,
    titleStart: head.length + path.length,
    updatedAt,
  };
}

export interface TitleHit {
  entry: SearchEntry;
  match: FuzzyMatch;
}

const byRecent = (a: SearchEntry, b: SearchEntry) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

export function searchTitles(query: string, entries: readonly SearchEntry[], limit = 50): TitleHit[] {
  const hits: TitleHit[] = [];
  for (const entry of entries) {
    const match = fuzzyMatch(query, entry.text, { boostFrom: entry.titleStart });
    if (match) hits.push({ entry, match });
  }
  hits.sort((a, b) => b.match.score - a.match.score || byRecent(a.entry, b.entry));
  return hits.slice(0, limit);
}

export interface Snippet {
  before: string;
  hit: string;
  after: string;
}

/** A short single-line excerpt around [index, index+length). */
export function makeSnippet(body: string, index: number, length: number, radius = 48): Snippet {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  let start = Math.max(0, index - radius);
  let end = Math.min(body.length, index + length + radius);
  // Prefer to cut at word boundaries.
  if (start > 0) {
    const sp = body.indexOf(' ', start);
    if (sp !== -1 && sp < index) start = sp + 1;
  }
  if (end < body.length) {
    const sp = body.lastIndexOf(' ', end);
    if (sp > index + length) end = sp;
  }
  return {
    before: (start > 0 ? '…' : '') + flat(body.slice(start, index)).trimStart(),
    hit: flat(body.slice(index, index + length)),
    after: flat(body.slice(index + length, end)).trimEnd() + (end < body.length ? '…' : ''),
  };
}

export interface BodyHit {
  entry: SearchEntry;
  snippet: Snippet;
}

/** Case-insensitive substring search over decrypted bodies. */
export function searchBodies(
  query: string,
  entries: readonly SearchEntry[],
  bodies: Readonly<Record<string, string>>,
  exclude: ReadonlySet<string>,
  limit = 20,
): BodyHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: BodyHit[] = [];
  const sorted = [...entries].sort(byRecent);
  for (const entry of sorted) {
    if (exclude.has(entry.noteId)) continue;
    const body = bodies[entry.noteId];
    if (!body) continue;
    const at = body.toLowerCase().indexOf(q);
    // toLowerCase can change string length for a few scripts; only trust aligned hits.
    if (at === -1 || body.slice(at, at + q.length).toLowerCase() !== q) continue;
    out.push({ entry, snippet: makeSnippet(body, at, q.length) });
    if (out.length >= limit) break;
  }
  return out;
}
