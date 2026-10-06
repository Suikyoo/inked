/**
 * Small fuzzy scorer for "vault / folder/path / title" strings.
 *
 * Query characters must appear in order (a subsequence). Among all alignments we pick the
 * best-scoring one with a DP, rewarding consecutive runs and word starts and penalising gaps
 * and long targets. Returns the matched indices for highlighting.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the target string, ascending. */
  indices: number[];
}

export interface FuzzyOptions {
  /** Matches at or after this index get a small bonus (e.g. the title part of a path). */
  boostFrom?: number;
}

const MATCH = 1;
const CONSECUTIVE = 5;
const WORD_START = 3;
const BOOST = 1;
const GAP = 0.2; // per skipped char between two matches
const LEAD = 0.05; // per char before the first match (capped)
const LEAD_CAP = 1.5;
const LENGTH = 0.05; // per char of target
const MAX_QUERY = 64;

const SEPARATORS = new Set([' ', '/', '-', '_', '.', ':', '\\', '(', '[', '#', '"', "'"]);

function lowerChar(c: string): string {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

function isWordStart(t: string, j: number): boolean {
  if (j === 0) return true;
  const prev = t[j - 1];
  const cur = t[j];
  if (SEPARATORS.has(prev)) return true;
  // camelCase and letter/digit boundaries
  if (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) return true;
  const pd = prev >= '0' && prev <= '9';
  const cd = cur >= '0' && cur <= '9';
  return pd !== cd && /[\p{L}\p{N}]/u.test(prev);
}

export function normalizeQuery(q: string): string {
  return Array.from(q.replace(/\s+/g, ''), lowerChar).join('');
}

export function fuzzyMatch(query: string, target: string, opts: FuzzyOptions = {}): FuzzyMatch | null {
  const q = normalizeQuery(query).slice(0, MAX_QUERY);
  const n = q.length;
  const m = target.length;
  if (n === 0 || m === 0 || n > m) return null;
  const t = Array.from({ length: m }, (_, i) => lowerChar(target[i]));

  // Cheap rejection: is q a subsequence of t at all?
  for (let i = 0, j = 0; i < n; j++) {
    if (j >= m) return null;
    if (t[j] === q[i]) i++;
  }

  const boostFrom = opts.boostFrom ?? Infinity;
  const charScore = (j: number) => MATCH + (isWordStart(target, j) ? WORD_START : 0) + (j >= boostFrom ? BOOST : 0);

  const NEG = -Infinity;
  let prev = new Float64Array(m).fill(NEG);
  const back: Int32Array[] = [];

  // Row 0: first query char.
  const row0 = new Int32Array(m).fill(-1);
  for (let j = 0; j < m; j++) {
    if (t[j] === q[0]) prev[j] = charScore(j) - Math.min(j * LEAD, LEAD_CAP);
  }
  back.push(row0);

  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m).fill(NEG);
    const from = new Int32Array(m).fill(-1);
    // Running best of prev[k] + GAP*k over k <= j-2 (non-adjacent predecessor).
    let runBest = NEG;
    let runArg = -1;
    for (let j = 1; j < m; j++) {
      const k = j - 2;
      if (k >= 0 && prev[k] !== NEG && prev[k] + GAP * k > runBest) {
        runBest = prev[k] + GAP * k;
        runArg = k;
      }
      if (t[j] !== q[i]) continue;
      let best = NEG;
      let arg = -1;
      if (runArg >= 0) {
        best = runBest - GAP * (j - 1);
        arg = runArg;
      }
      if (prev[j - 1] !== NEG) {
        const adj = prev[j - 1] + CONSECUTIVE;
        if (adj >= best) {
          best = adj;
          arg = j - 1;
        }
      }
      if (arg >= 0) {
        cur[j] = best + charScore(j);
        from[j] = arg;
      }
    }
    back.push(from);
    prev = cur;
  }

  let endScore = NEG;
  let end = -1;
  for (let j = 0; j < m; j++) {
    if (prev[j] > endScore) {
      endScore = prev[j];
      end = j;
    }
  }
  if (end < 0) return null;

  const indices = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = back[i][j];
  }
  return { score: endScore - m * LENGTH, indices };
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits `text` into highlighted / plain runs. `offset` shifts indices (for substrings). */
export function highlightSegments(text: string, indices: readonly number[], offset = 0): Segment[] {
  const hits = new Set(indices.map((i) => i - offset));
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
