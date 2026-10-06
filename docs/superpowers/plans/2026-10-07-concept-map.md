# Concept Map (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Home map placeholder with a pan/zoom concept map of every vault, and add a 1-hop local map to the note page.

**Architecture:**
- Pure functions in `web/src/map/` build three things from the decrypted tree and bodies that `AppState` already holds:
  - a per-vault link graph;
  - a deterministic ring layout;
  - a world scene.
- React SVG components (`ConceptMap`, `LocalMap`) draw the scene. Pan and zoom are hand-written, using screen-space coordinates.
- No server, API, crypto or storage change.

**Tech Stack:** React 18, react-router-dom 7, TypeScript 5.9, vitest 5 (jsdom for components, `act` + `createRoot`; there is no testing-library), plain CSS with custom properties.

**Spec:** `docs/superpowers/specs/2026-10-07-concept-map-design.md`

## Global Constraints

- No new runtime or dev dependencies.
- No change under `server/`, and no new HTTP request from the web app.
- Nothing is written to localStorage, sessionStorage or IndexedDB. The only allowed keys remain `inked.lastUsername` and `inked.spellcheck`.
- CSP is `style-src 'self'`.
  - Never inject `<style>` elements or set a `style` attribute string.
  - React `style` props are allowed.
  - SVG presentation attributes (`x`, `fill`, `transform`, …) are allowed.
- Colours are CSS custom properties in `web/src/styles/tokens.css`:
  - `--ink-wet: #b69cff`, `--ink-fresh: #9d7cf2`, `--ink-drying: #6b5a9e`, `--ink-dry: #524b6e`
  - `--map-pencil: #4a4659`, `--map-ink: #9d7cf2`, `--map-sel: #ede9ff`
- Recency tiers: under 24 h `wet`, under 7 d `fresh`, under 30 d `drying`, else `dry`. Upper bounds are exclusive. An invalid or future timestamp counts as `wet`.
- Text on the map uses text tokens (`--text`, `--muted`, `--muted-3`), never a tier colour.
- Dots are radius 4 (8 px marker), or 5 when selected, hot, hovered or focused. Each has a 2 px canvas-coloured ring and a transparent hit circle of radius 12 (a 24 px target).
- Zoom is clamped to 0.4–4. Labels appear at scale 1.6 and above. A drag starts at 4 px of movement. Fit padding is 24 px. Animated fits take 200 ms.
- User-facing strings (exact):
  - "Decrypting your notes…"
  - "Couldn’t load"
  - "Links appear once note text is decrypted."
  - "Drawing links…"
  - "No neighbours yet"
  - "Open note →"
  - "Untitled"
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands:
  - run from the repo root: `C:\Users\User\Desktop\stuff\notes` (Git Bash path `/c/Users/User/Desktop/stuff/notes`);
  - web tests: `npm test -w web` (one file: `npm test -w web -- src/map/graph.test.ts`);
  - typecheck and build: `npm run build -w web`.

## Review Focus

1. **Corrupt folder data.** A folder cycle or a missing parent in a decrypted tree must not hang or crash the map; the folder becomes top-level. Test: Task 1.
2. **Duplicate note titles.** `[[Title]]` must resolve to the most recently edited note with that title, the same note a click on the link opens. Test: Task 1.
3. **Vault data arriving after first paint.** A vault that goes from `loading` to `ready` must refit the view, not leave dots off-screen at the empty-vault zoom. Test: Task 6.
4. **A drag that ends over a dot must pan, not select.** Test: Task 6.
5. **Untitled notes.** A note with an empty title must show "Untitled" in its label and aria-label, never a blank. Test: Task 4.

## File structure

| File | Responsibility |
|---|---|
| `web/src/lib/titles.ts` (new) | `titleIndex`, moved out of `StoreContext.tsx` so pure modules can import it without React |
| `web/src/map/fixtures.ts` (new) | Test fixture builders: `folder`, `note`, `tree`, `vault` |
| `web/src/map/graph.ts` (new) | `VaultGraph`, `buildVaultGraph`, `noteLinkTargets`; later `structureKey`, `incomingLinks` |
| `web/src/map/recency.ts` (new) | `inkTier` |
| `web/src/map/layout.ts` (new) | `layoutVault`, `layoutWorld`, `noteRows`, layout constants |
| `web/src/map/useViewport.ts` (new) | View maths (`zoomAt`, `fit`, `panBy`, …) and the `useViewport` hook |
| `web/src/map/scene.ts` (new) | `buildScene` (world geometry), `taperPath`, `nearestInDirection`, `arrowDir`, `displayTitle` |
| `web/src/map/useVaultGraphs.ts` (new) | `MapEntry`, `mapEntries` (cached layouts), `useVaultGraphs`, `useVaultGraph` |
| `web/src/map/ConceptMap.tsx` (new) | Home SVG map plus `MapLegend` |
| `web/src/map/MapSlip.tsx` (new) | Selection card |
| `web/src/map/localGraph.ts` (new) | `localGraph` (1-hop neighbourhood) |
| `web/src/map/LocalMap.tsx` (new) | Note-page local map |
| `web/src/styles/map.css` (new) | Map styles |
| `web/src/styles/tokens.css` | Add map tokens |
| `web/src/components/Icons.tsx` | Add `MinusIcon`, `FitIcon` |
| `web/src/state/StoreContext.tsx` | Re-export `titleIndex` |
| `web/src/pages/HomePage.tsx` | Use `ConceptMap`, `hits`, `hot` |
| `web/src/pages/NotePane.tsx` | Backlinks from the graph, Local map section |
| `web/src/styles/home.css` | Remove `.map-placeholder` |
| `web/src/main.tsx` | Import `map.css` |
| `docs/architecture.md` | Map and link-graph notes |

---

### Task 1: Link graph and recency tiers

**Files:**
- Create: `web/src/lib/titles.ts`, `web/src/map/fixtures.ts`, `web/src/map/graph.ts`, `web/src/map/recency.ts`
- Modify: `web/src/state/StoreContext.tsx` (the `titleIndex` definition, at the end of the file)
- Test: `web/src/map/graph.test.ts`, `web/src/map/recency.test.ts`

**Interfaces:**
- Consumes: `wikiLinkTargets(src): Set<string>` from `web/src/markdown/plugins.ts` (lower-cased, trimmed targets); `TreeView`, `FolderView`, `NoteView`, `VaultView` types from `web/src/state/store.ts`.
- Produces:
  - `titleIndex(tree: TreeView | undefined): Map<string, string>` in `lib/titles.ts`. Still exported from `StoreContext.tsx`.
  - Graph types: `GraphFolder`, `GraphNote`, `GraphLink`, `VaultGraph`.
  - `buildVaultGraph(vaultId: string, tree: TreeView, bodies: Record<string, string>, bodiesReady: boolean): VaultGraph`
  - `noteLinkTargets(src: string, vaultId: string, titles: Map<string, string>): Set<string>`
  - `type InkTier = 'wet' | 'fresh' | 'drying' | 'dry'` and `inkTier(updatedAt: string, now: number): InkTier`
  - Fixtures: `T0`, `folder(id, parentId, name?, extra?)`, `note(id, folderId, title?, extra?)`, `tree(folders, notes, status?)`, `vault(id, name?)`

- [ ] **Step 1: Move `titleIndex` into `web/src/lib/titles.ts`**

```ts
import type { TreeView } from '../state/store';

/** Lower-cased title -> note id within one vault (most recently edited wins on duplicates). */
export function titleIndex(tree: TreeView | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!tree) return map;
  const notes = Object.values(tree.notes).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const n of notes) map.set(n.title.trim().toLowerCase(), n.id);
  return map;
}
```

In `web/src/state/StoreContext.tsx`, delete the `titleIndex` function and its doc comment (the last function in the file). Add next to the other imports:

```ts
import { titleIndex } from '../lib/titles';
```

and at the end of the file:

```ts
export { titleIndex };
```

Run: `npm run build -w web`
Expected: success. Existing importers (`NotePane.tsx`) still compile.

- [ ] **Step 2: Create fixtures `web/src/map/fixtures.ts`**

```ts
import type { FolderView, NoteView, TreeView, VaultView } from '../state/store';

/** Shared test builders for the map modules. Not imported by app code. */
export const T0 = '2026-10-01T00:00:00.000Z';

export function folder(id: string, parentId: string | null, name = id, extra: Partial<FolderView> = {}): FolderView {
  return { id, vaultId: 'v1', parentId, name, createdAt: T0, updatedAt: T0, ...extra };
}

export function note(id: string, folderId: string | null, title = id, extra: Partial<NoteView> = {}): NoteView {
  return { id, vaultId: 'v1', folderId, title, size: 0, createdAt: T0, updatedAt: T0, ...extra };
}

export function tree(folders: FolderView[], notes: NoteView[], status: TreeView['status'] = 'ready'): TreeView {
  return {
    status,
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    notes: Object.fromEntries(notes.map((n) => [n.id, n])),
  };
}

export function vault(id: string, name = `Vault ${id}`): VaultView {
  return { id, name, color: '#9d7cf2', createdAt: T0, updatedAt: T0, noteCount: 0, activeNoteCount7d: 0 };
}
```

- [ ] **Step 3: Write the failing tests `web/src/map/graph.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph, noteLinkTargets } from './graph';

describe('noteLinkTargets', () => {
  it('resolves wiki-links case-insensitively, with or without an alias', () => {
    const titles = new Map([['alpha', 'n1']]);
    expect([...noteLinkTargets('see [[Alpha]] and [[ALPHA|the a note]]', 'v1', titles)]).toEqual(['n1']);
  });

  it('resolves root-relative note links in the same vault, with or without a suffix', () => {
    const src = '[a](/v/v1/n/n2) [b](/v/v1/n/n3#part) [c](/v/v1/n/n4?x=1) [d](</v/v1/n/n5>) [e](/v/v1/n/n6 "t")';
    expect([...noteLinkTargets(src, 'v1', new Map())].sort()).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('ignores other vaults, other routes and absolute URLs', () => {
    const src = '[a](/v/v2/n/n2) [b](/v/v1/n/n2/extra) [c](/v/v1) [d](https://x.example/v/v1/n/n9)';
    expect(noteLinkTargets(src, 'v1', new Map()).size).toBe(0);
  });
});

describe('buildVaultGraph', () => {
  it('drops self-links and unknown targets, and merges duplicate links', () => {
    const t = tree([], [note('n1', null, 'one'), note('n2', null, 'two')]);
    const bodies = { n1: '[[one]] [[two]] [[TWO]] [x](/v/v1/n/n2) [[ghost]] [y](/v/v1/n/zzz)' };
    expect(buildVaultGraph('v1', t, bodies, true).links).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it('leaves out broken notes and folders; a note in a broken folder goes to the root', () => {
    const t = tree([folder('f1', null, 'Bad', { broken: true })], [note('n1', 'f1'), note('n2', null, 'x', { broken: true })]);
    const g = buildVaultGraph('v1', t, {}, true);
    expect(g.folders).toEqual([]);
    expect(g.notes).toEqual([{ id: 'n1', folderId: null, title: 'n1', updatedAt: expect.any(String) }]);
  });

  it('survives folder cycles and missing parents (Review Focus 1)', () => {
    const t = tree([folder('f1', 'f2'), folder('f2', 'f1'), folder('f3', 'gone')], [note('n1', 'f1')]);
    const g = buildVaultGraph('v1', t, {}, true);
    const f3 = g.folders.find((f) => f.id === 'f3')!;
    expect(f3).toMatchObject({ parentId: null, depth: 0 });
    const cyc = g.folders.filter((f) => f.id !== 'f3');
    expect(cyc.map((f) => f.depth).sort()).toEqual([0, 1]);
    expect(cyc.filter((f) => f.parentId === null)).toHaveLength(1);
  });

  it('resolves a duplicate title to the most recently edited note (Review Focus 2)', () => {
    const t = tree([], [
      note('a', null, 'Same', { updatedAt: '2026-10-01T00:00:00.000Z' }),
      note('b', null, 'Same', { updatedAt: '2026-10-05T00:00:00.000Z' }),
      note('c', null, 'Linker'),
    ]);
    expect(buildVaultGraph('v1', t, { c: '[[same]]' }, true).links).toEqual([{ from: 'c', to: 'b' }]);
  });

  it('records folder depth and mirrors bodiesReady', () => {
    const t = tree([folder('f1', null), folder('f2', 'f1')], []);
    const g = buildVaultGraph('v1', t, {}, false);
    expect(g.folders.map((f) => [f.id, f.depth])).toEqual([['f1', 0], ['f2', 1]]);
    expect(g.linksReady).toBe(false);
  });
});
```

- [ ] **Step 4: Write the failing tests `web/src/map/recency.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { inkTier } from './recency';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('inkTier', () => {
  it('steps wet → fresh → drying → dry at 24 h, 7 d and 30 d (upper bounds exclusive)', () => {
    expect(inkTier(ago(D - 1), NOW)).toBe('wet');
    expect(inkTier(ago(D), NOW)).toBe('fresh');
    expect(inkTier(ago(7 * D - 1), NOW)).toBe('fresh');
    expect(inkTier(ago(7 * D), NOW)).toBe('drying');
    expect(inkTier(ago(30 * D - 1), NOW)).toBe('drying');
    expect(inkTier(ago(30 * D), NOW)).toBe('dry');
  });

  it('treats unparseable and future timestamps as wet', () => {
    expect(inkTier('not a date', NOW)).toBe('wet');
    expect(inkTier(ago(-H), NOW)).toBe('wet');
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -w web -- src/map/graph.test.ts src/map/recency.test.ts`
Expected: FAIL. The modules `./graph` and `./recency` cannot be resolved.

- [ ] **Step 6: Implement `web/src/map/graph.ts`**

```ts
import { titleIndex } from '../lib/titles';
import { wikiLinkTargets } from '../markdown/plugins';
import type { TreeView } from '../state/store';

export interface GraphFolder {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
}
export interface GraphNote {
  id: string;
  folderId: string | null;
  title: string;
  updatedAt: string;
}
export interface GraphLink {
  from: string;
  to: string;
}
export interface VaultGraph {
  vaultId: string;
  folders: GraphFolder[];
  notes: GraphNote[];
  links: GraphLink[];
  /** Mirrors bodiesReady: until then links may be missing. */
  linksReady: boolean;
}

// `](/v/<vault>/n/<note>` followed by `#`, `?`, `)`, whitespace, `>` or `"`.
const NOTE_LINK_RE = /\]\(\s*<?\/v\/([^/\s#?)>"]+)\/n\/([^/\s#?)>"]+)(?=[#?)\s>"])/g;

/** Note ids a Markdown body links to: [[wiki-links]] by title, and root-relative links in this vault. */
export function noteLinkTargets(src: string, vaultId: string, titles: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const t of wikiLinkTargets(src)) {
    const id = titles.get(t);
    if (id) out.add(id);
  }
  for (const m of src.matchAll(NOTE_LINK_RE)) {
    if (m[1] === vaultId) out.add(m[2]);
  }
  return out;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byLink = (a: GraphLink, b: GraphLink) =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;

export function buildVaultGraph(
  vaultId: string,
  tree: TreeView,
  bodies: Record<string, string>,
  bodiesReady: boolean,
): VaultGraph {
  const live = new Map(Object.values(tree.folders).filter((f) => !f.broken).map((f) => [f.id, f]));

  // A missing or broken parent makes the folder top-level.
  const parentOf = new Map<string, string | null>();
  for (const f of live.values()) parentOf.set(f.id, f.parentId && live.has(f.parentId) ? f.parentId : null);
  // Corrupt data could hold a cycle: cut it where it is first seen.
  for (const f of live.values()) {
    const seen = new Set([f.id]);
    for (let p = parentOf.get(f.id) ?? null; p; p = parentOf.get(p) ?? null) {
      if (seen.has(p)) {
        parentOf.set(f.id, null);
        break;
      }
      seen.add(p);
    }
  }
  const depthOf = (id: string) => {
    let d = 0;
    for (let p = parentOf.get(id) ?? null; p; p = parentOf.get(p) ?? null) d++;
    return d;
  };

  const folders: GraphFolder[] = [...live.values()]
    .map((f) => ({ id: f.id, parentId: parentOf.get(f.id) ?? null, name: f.name, depth: depthOf(f.id) }))
    .sort(byId);

  const liveNotes = Object.values(tree.notes).filter((n) => !n.broken);
  const notes: GraphNote[] = liveNotes
    .map((n) => ({
      id: n.id,
      folderId: n.folderId && live.has(n.folderId) ? n.folderId : null,
      title: n.title,
      updatedAt: n.updatedAt,
    }))
    .sort(byId);

  const ids = new Set(notes.map((n) => n.id));
  const titles = titleIndex({ ...tree, notes: Object.fromEntries(liveNotes.map((n) => [n.id, n])) });
  const links: GraphLink[] = [];
  for (const n of notes) {
    const body = bodies[n.id];
    if (!body) continue;
    for (const to of noteLinkTargets(body, vaultId, titles)) {
      if (to !== n.id && ids.has(to)) links.push({ from: n.id, to });
    }
  }
  links.sort(byLink);

  return { vaultId, folders, notes, links, linksReady: bodiesReady };
}
```

- [ ] **Step 7: Implement `web/src/map/recency.ts`**

```ts
export type InkTier = 'wet' | 'fresh' | 'drying' | 'dry';

const DAY = 86_400_000;

/** How wet a note's ink is: recency of its last edit. Unknown or future times read as wet. */
export function inkTier(updatedAt: string, now: number): InkTier {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 'wet';
  const age = now - t;
  if (age < DAY) return 'wet';
  if (age < 7 * DAY) return 'fresh';
  if (age < 30 * DAY) return 'drying';
  return 'dry';
}
```

- [ ] **Step 8: Run the tests to verify they pass, then run the full web suite and the build**

Run: `npm test -w web -- src/map/graph.test.ts src/map/recency.test.ts`
Expected: PASS (10 tests).
Run: `npm test -w web` then `npm run build -w web`
Expected: all pass; the build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/titles.ts web/src/state/StoreContext.tsx web/src/map/fixtures.ts web/src/map/graph.ts web/src/map/graph.test.ts web/src/map/recency.ts web/src/map/recency.test.ts
git commit -m "feat(map): vault link graph and wet/dry recency tiers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ring layout

**Files:**
- Create: `web/src/map/layout.ts`
- Test: `web/src/map/layout.test.ts`

**Interfaces:**
- Consumes: `VaultGraph`, `GraphFolder`, `GraphNote`, `buildVaultGraph` (Task 1); fixtures `folder`, `note`, `tree` (Task 1).
- Produces:
  - `interface Pt { x: number; y: number }`
  - `interface VaultLayout { vaultId: string; radius: number; folders: Record<string, Pt>; notes: Record<string, Pt>; parent: Record<string, string | null> }`
  - `layoutVault(graph: VaultGraph): VaultLayout`, in vault-local coordinates with the hub at (0,0)
  - `layoutWorld(layouts: VaultLayout[], gap?: number): Record<string, Pt>`, giving vault centres
  - `noteRows(count: number, span: number, r0: number): { r: number; n: number }[]`
  - constants `R0, RSTEP, NR, NSTEP, MIN_GAP, LABEL_MARGIN`

Layout rules (spec section 1):
- Slice weight is `1 + the weights of the child folders` (folders only), so adding a note never resizes another folder's slice.
- A folder's notes sit in hub-centred rows at `r + NR + k·NSTEP` inside the folder's slice. A row holds as many notes as keep the chord between neighbours at `MIN_GAP` or more.
- Child folders sit at `max(r + RSTEP, outermost own note row + NR)`.
- Root notes get their own slice, first, starting at angle −π/2, with rows starting at `R0`.

- [ ] **Step 1: Write the failing tests `web/src/map/layout.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { MIN_GAP, layoutVault, layoutWorld, type VaultLayout } from './layout';
import type { FolderView, NoteView } from '../state/store';

const graphOf = (folders: FolderView[], notes: NoteView[]) => buildVaultGraph('v1', tree(folders, notes), {}, true);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('layoutVault', () => {
  it('is deterministic, whatever order the tree lists things in', () => {
    const fs = [folder('f1', null, 'B'), folder('f2', null, 'A'), folder('f3', 'f1', 'C')];
    const ns = [note('n1', 'f1', 'x'), note('n2', 'f3', 'y'), note('n3', null, 'z'), note('n4', 'f2', 'w')];
    const a = layoutVault(graphOf(fs, ns));
    const b = layoutVault(graphOf([...fs].reverse(), [...ns].reverse()));
    expect(b).toEqual(a);
    expect(layoutVault(graphOf(fs, ns))).toEqual(a);
  });

  it('adding a note to folder A moves no dot in folder B or its subfolders', () => {
    const fs = [folder('fa', null, 'A'), folder('fb', null, 'B'), folder('fb2', 'fb', 'B2')];
    const ns = [note('a1', 'fa'), note('b1', 'fb'), note('b2', 'fb2'), note('r1', null)];
    const before = layoutVault(graphOf(fs, ns));
    const after = layoutVault(graphOf(fs, [...ns, note('a2', 'fa'), note('a3', 'fa')]));
    for (const id of ['fb', 'fb2']) expect(after.folders[id]).toEqual(before.folders[id]);
    for (const id of ['b1', 'b2', 'r1']) expect(after.notes[id]).toEqual(before.notes[id]);
  });

  it('places root notes around the hub with a null parent', () => {
    const l = layoutVault(graphOf([], [note('r1', null), note('r2', null)]));
    expect(Object.keys(l.notes).sort()).toEqual(['r1', 'r2']);
    expect(l.parent.r1).toBeNull();
    expect(dist(l.notes.r1, { x: 0, y: 0 })).toBeGreaterThan(0);
  });

  it('nests four folder levels outward, each parent recorded', () => {
    const fs = [folder('f1', null), folder('f2', 'f1'), folder('f3', 'f2'), folder('f4', 'f3')];
    const l = layoutVault(graphOf(fs, [note('n1', 'f4')]));
    const o = { x: 0, y: 0 };
    expect(dist(l.folders.f2, o)).toBeGreaterThan(dist(l.folders.f1, o));
    expect(dist(l.folders.f3, o)).toBeGreaterThan(dist(l.folders.f2, o));
    expect(dist(l.folders.f4, o)).toBeGreaterThan(dist(l.folders.f3, o));
    expect(l.parent).toMatchObject({ f1: null, f2: 'f1', f3: 'f2', f4: 'f3', n1: 'f4' });
    expect(l.radius).toBeGreaterThan(dist(l.notes.n1, o));
  });

  it('keeps neighbouring dots in one row at least MIN_GAP apart', () => {
    const fs = [folder('f1', null), folder('f2', null), folder('f3', 'f1')];
    const ns = [
      ...Array.from({ length: 60 }, (_, i) => note(`a${i}`, 'f1', `a${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 30 }, (_, i) => note(`r${i}`, null, `r${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 25 }, (_, i) => note(`c${i}`, 'f3', `c${String(i).padStart(2, '0')}`)),
    ];
    const l = layoutVault(graphOf(fs, ns));
    const rows = new Map<string, { x: number; y: number }[]>();
    for (const [id, p] of Object.entries(l.notes)) {
      const key = `${l.parent[id]}|${Math.round(Math.hypot(p.x, p.y) * 1000)}`;
      rows.set(key, [...(rows.get(key) ?? []), p]);
    }
    expect(rows.size).toBeGreaterThan(3);
    for (const pts of rows.values()) {
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) expect(dist(pts[i], pts[j])).toBeGreaterThanOrEqual(MIN_GAP - 1e-6);
    }
  });

  it('gives an empty vault a hub-only layout', () => {
    const l = layoutVault(graphOf([], []));
    expect(l).toMatchObject({ vaultId: 'v1', folders: {}, notes: {}, parent: {} });
    expect(l.radius).toBeGreaterThan(0);
  });

  it('lays out 1,000 notes in 40 folders in under 50 ms', () => {
    const fs: FolderView[] = [];
    for (let i = 0; i < 10; i++) {
      fs.push(folder(`t${i}`, null, `top ${i}`));
      for (let j = 0; j < 3; j++) fs.push(folder(`t${i}c${j}`, `t${i}`, `child ${j}`));
    }
    const ns = Array.from({ length: 1000 }, (_, i) => note(`n${i}`, fs[i % fs.length].id, `note ${i}`));
    const g = graphOf(fs, ns);
    layoutVault(g); // warm-up
    const t0 = performance.now();
    const l = layoutVault(g);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(Object.keys(l.notes)).toHaveLength(1000);
  });
});

describe('layoutWorld', () => {
  it('places vault circles in rows without overlap, in the given order', () => {
    const fake = (id: string, radius: number): VaultLayout => ({ vaultId: id, radius, folders: {}, notes: {}, parent: {} });
    const ls = [fake('a', 60), fake('b', 200), fake('c', 90), fake('d', 300), fake('e', 75)];
    const c = layoutWorld(ls, 48);
    expect(Object.keys(c)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++)
        expect(dist(c[ls[i].vaultId], c[ls[j].vaultId])).toBeGreaterThanOrEqual(ls[i].radius + ls[j].radius);
    expect(layoutWorld([])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/map/layout.test.ts`
Expected: FAIL. `./layout` cannot be resolved.

- [ ] **Step 3: Implement `web/src/map/layout.ts`**

```ts
import type { GraphFolder, GraphNote, VaultGraph } from './graph';

export interface Pt {
  x: number;
  y: number;
}

/** Vault-local positions; the hub sits at (0,0). */
export interface VaultLayout {
  vaultId: string;
  /** Hub to farthest dot, plus room for its label. */
  radius: number;
  folders: Record<string, Pt>;
  notes: Record<string, Pt>;
  /** Folder or note id -> parent folder id, or null for the hub. */
  parent: Record<string, string | null>;
}

/** Hub to the top-level folders and the first root-note row. */
export const R0 = 70;
/** Minimum folder to child-folder distance. */
export const RSTEP = 70;
/** Folder to its first note row. */
export const NR = 26;
/** Between note rows; not less than MIN_GAP. */
export const NSTEP = 14;
/** Minimum chord between neighbouring dots in one row. */
export const MIN_GAP = 12;
/** Room past the farthest dot for its label. */
export const LABEL_MARGIN = 28;
const MIN_RADIUS = 60;
const START = -Math.PI / 2;

const polar = (r: number, a: number): Pt => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const tie = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = (a: GraphFolder, b: GraphFolder) => a.name.localeCompare(b.name) || tie(a, b);
const byTitle = (a: GraphNote, b: GraphNote) => a.title.localeCompare(b.title) || tie(a, b);

/** Rows for `count` notes spread across an angular `span`, the first at hub radius `r0`. */
export function noteRows(count: number, span: number, r0: number): { r: number; n: number }[] {
  const rows: { r: number; n: number }[] = [];
  for (let left = count, k = 0; left > 0; k++) {
    const r = r0 + k * NSTEP;
    const step = 2 * Math.asin(Math.min(1, MIN_GAP / (2 * r)));
    const n = Math.min(left, Math.max(1, Math.floor(span / step + 1e-9)));
    rows.push({ r, n });
    left -= n;
  }
  return rows;
}

export function layoutVault(graph: VaultGraph): VaultLayout {
  const kids = new Map<string | null, GraphFolder[]>();
  for (const f of graph.folders) kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), f]);
  for (const list of kids.values()) list.sort(byName);
  const notesIn = new Map<string | null, GraphNote[]>();
  for (const n of graph.notes) notesIn.set(n.folderId, [...(notesIn.get(n.folderId) ?? []), n]);
  for (const list of notesIn.values()) list.sort(byTitle);

  // Folders only, so a new note never resizes another folder's slice.
  const weights = new Map<string, number>();
  const weight = (f: GraphFolder): number => {
    let w = weights.get(f.id);
    if (w === undefined) {
      w = 1 + (kids.get(f.id) ?? []).reduce((s, c) => s + weight(c), 0);
      weights.set(f.id, w);
    }
    return w;
  };

  const out: VaultLayout = { vaultId: graph.vaultId, radius: 0, folders: {}, notes: {}, parent: {} };
  let far = 0;

  const placeNotes = (list: GraphNote[], parent: string | null, a0: number, span: number, r0: number): number => {
    let i = 0;
    let outer = 0;
    for (const row of noteRows(list.length, span, r0)) {
      for (let j = 0; j < row.n; j++, i++) {
        out.notes[list[i].id] = polar(row.r, a0 + ((j + 0.5) * span) / row.n);
        out.parent[list[i].id] = parent;
      }
      outer = row.r;
    }
    far = Math.max(far, outer);
    return outer;
  };

  const placeFolder = (f: GraphFolder, a0: number, span: number, r: number) => {
    out.folders[f.id] = polar(r, a0 + span / 2);
    out.parent[f.id] = f.parentId;
    far = Math.max(far, r);
    const outer = placeNotes(notesIn.get(f.id) ?? [], f.id, a0, span, r + NR);
    const childR = Math.max(r + RSTEP, outer + NR);
    const children = kids.get(f.id) ?? [];
    const total = children.reduce((s, c) => s + weight(c), 0);
    let a = a0;
    for (const c of children) {
      const s = (span * weight(c)) / total;
      placeFolder(c, a, s, childR);
      a += s;
    }
  };

  const top = kids.get(null) ?? [];
  const rootNotes = notesIn.get(null) ?? [];
  const total = top.reduce((s, f) => s + weight(f), 0) + (rootNotes.length ? 1 : 0);
  let a = START;
  if (rootNotes.length) {
    const s = (2 * Math.PI) / total;
    placeNotes(rootNotes, null, a, s, R0);
    a += s;
  }
  for (const f of top) {
    const s = (2 * Math.PI * weight(f)) / total;
    placeFolder(f, a, s, R0);
    a += s;
  }
  out.radius = Math.max(MIN_RADIUS, far + LABEL_MARGIN);
  return out;
}

/** World-space centre of each vault: circles packed in rows, in the given order. */
export function layoutWorld(layouts: VaultLayout[], gap = 48): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  if (!layouts.length) return out;
  const cell = (l: VaultLayout) => 2 * l.radius + gap;
  const cells = layouts.map(cell);
  const width = Math.max(Math.max(...cells), Math.sqrt(cells.reduce((s, c) => s + c * c, 0)));
  const rows: VaultLayout[][] = [];
  let row: VaultLayout[] = [];
  let used = 0;
  layouts.forEach((l, i) => {
    if (row.length && used + cells[i] > width + 1e-6) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(l);
    used += cells[i];
  });
  rows.push(row);
  let y = 0;
  for (const r of rows) {
    const h = Math.max(...r.map(cell));
    let x = 0;
    for (const l of r) {
      out[l.vaultId] = { x: x + gap / 2 + l.radius, y: y + h / 2 };
      x += cell(l);
    }
    y += h;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/map/layout.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/map/layout.ts web/src/map/layout.test.ts
git commit -m "feat(map): deterministic ring layout per vault and world packing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Viewport maths and hook

**Files:**
- Create: `web/src/map/useViewport.ts`
- Test: `web/src/map/useViewport.test.ts`

**Interfaces:**
- Consumes: `Pt` from `./layout` (Task 2).
- Produces:
  - `interface View { scale: number; tx: number; ty: number }`. Screen position = world position × scale + t.
  - `interface Bounds { minX: number; minY: number; maxX: number; maxY: number }` and `interface Size { w: number; h: number }`.
  - `MIN_SCALE = 0.4`, `MAX_SCALE = 4`, `clampScale`, `toScreen(v, p): Pt`, `toWorld(v, p): Pt`.
  - `zoomAt(v, factor, px, py): View`, `panBy(v, dx, dy): View`, `fit(b, size, padding = 24): View`, `lerpView(a, b, t): View`.
  - `useViewport(initial: View | (() => View)): { view: View; setView: (next: View | ((v: View) => View)) => void; animateTo: (target: View) => void }`.
    - `animateTo` eases over 200 ms with `requestAnimationFrame`.
    - It jumps straight to the target when `matchMedia` is missing (as in jsdom), when `prefers-reduced-motion: reduce` matches, or when `requestAnimationFrame` is missing.
    - `setView` cancels any running animation.

- [ ] **Step 1: Write the failing tests `web/src/map/useViewport.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, fit, lerpView, panBy, toScreen, toWorld, zoomAt } from './useViewport';

describe('viewport maths', () => {
  it('zoomAt keeps the world point under the cursor fixed', () => {
    const v = { scale: 1.3, tx: 40, ty: -20 };
    const w = toWorld(v, { x: 200, y: 150 });
    const s = toScreen(zoomAt(v, 1.7, 200, 150), w);
    expect(s.x).toBeCloseTo(200, 6);
    expect(s.y).toBeCloseTo(150, 6);
  });

  it('clamps scale to 0.4–4 and still keeps the cursor point fixed', () => {
    const v = { scale: 3.5, tx: 0, ty: 0 };
    const z = zoomAt(v, 2, 100, 100);
    expect(z.scale).toBe(MAX_SCALE);
    const s = toScreen(z, toWorld(v, { x: 100, y: 100 }));
    expect(s.x).toBeCloseTo(100, 6);
    expect(zoomAt({ scale: 0.5, tx: 0, ty: 0 }, 0.1, 0, 0).scale).toBe(MIN_SCALE);
  });

  it('fit centres the bounds and scales them into the padded frame', () => {
    const v = fit({ minX: -100, minY: -50, maxX: 300, maxY: 150 }, { w: 800, h: 480 }, 24);
    expect(v.scale).toBeCloseTo(Math.min(752 / 400, 432 / 200), 6);
    const c = toScreen(v, { x: 100, y: 50 });
    expect(c.x).toBeCloseTo(400, 6);
    expect(c.y).toBeCloseTo(240, 6);
    expect(fit({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, { w: 800, h: 480 }).scale).toBe(MAX_SCALE);
  });

  it('panBy shifts and lerpView interpolates', () => {
    expect(panBy({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
    expect(lerpView({ scale: 1, tx: 0, ty: 0 }, { scale: 3, tx: 10, ty: -10 }, 0.5)).toEqual({ scale: 2, tx: 5, ty: -5 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- src/map/useViewport.test.ts`
Expected: FAIL. `./useViewport` cannot be resolved.

- [ ] **Step 3: Implement `web/src/map/useViewport.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pt } from './layout';

/** screen = world * scale + t */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 4;
const ANIM_MS = 200;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
export const toScreen = (v: View, p: Pt): Pt => ({ x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty });
export const toWorld = (v: View, p: Pt): Pt => ({ x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale });

/** Zoom by `factor` around screen point (px, py), which stays put. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

export const panBy = (v: View, dx: number, dy: number): View => ({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy });

/** The view that centres `b` in `size`, as large as the padding and the scale limits allow. */
export function fit(b: Bounds, size: Size, padding = 24): View {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const scale = clampScale(Math.min((size.w - 2 * padding) / bw, (size.h - 2 * padding) / bh));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { scale, tx: size.w / 2 - cx * scale, ty: size.h / 2 - cy * scale };
}

export const lerpView = (a: View, b: View, t: number): View => ({
  scale: a.scale + (b.scale - a.scale) * t,
  tx: a.tx + (b.tx - a.tx) * t,
  ty: a.ty + (b.ty - a.ty) * t,
});

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useViewport(initial: View | (() => View)) {
  const [view, setRaw] = useState<View>(initial);
  const current = useRef(view);
  current.current = view;
  const frame = useRef(0);

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  const setView = useCallback(
    (next: View | ((v: View) => View)) => {
      stop();
      setRaw(next);
    },
    [stop],
  );

  const animateTo = useCallback(
    (target: View) => {
      stop();
      if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
        setRaw(target);
        return;
      }
      const from = current.current;
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / ANIM_MS);
        setRaw(lerpView(from, target, 1 - (1 - k) ** 3));
        frame.current = k < 1 ? requestAnimationFrame(step) : 0;
      };
      frame.current = requestAnimationFrame(step);
    },
    [stop],
  );

  useEffect(() => stop, [stop]);
  return { view, setView, animateTo };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w web -- src/map/useViewport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/map/useViewport.ts web/src/map/useViewport.test.ts
git commit -m "feat(map): viewport maths (zoom at point, fit, pan) and animated hook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: World scene, tapered ink and arrow-key navigation

**Files:**
- Create: `web/src/map/scene.ts`
- Test: `web/src/map/scene.test.ts`

**Interfaces:**
- Consumes: `VaultGraph`, `buildVaultGraph` (Task 1); `layoutVault`, `layoutWorld`, `Pt`, `VaultLayout` (Task 2); `Bounds` (Task 3); fixtures (Task 1).
- Produces:
  - `interface SceneInput { vaultId: string; graph: VaultGraph; layout: VaultLayout }`
  - `interface SceneDot { id: string; vaultId: string; x: number; y: number; title: string; folderPath: string; updatedAt: string; links: number }`. `title` is already passed through `displayTitle`. `folderPath` is folder names joined with `' / '`, and `''` at the root. `links` counts distinct linked neighbours.
  - `interface SceneFolder { id: string; vaultId: string; x: number; y: number; name: string }`
  - `interface SceneHub { vaultId: string; x: number; y: number; radius: number }`
  - `interface Seg { x1: number; y1: number; x2: number; y2: number }`
  - `interface Scene { dots: SceneDot[]; folders: SceneFolder[]; hubs: SceneHub[]; pencil: Seg[]; links: Seg[]; linksPending: boolean; bounds: Bounds; vaultBounds: Record<string, Bounds>; chains: Record<string, Pt[]> }`. Everything is in world coordinates. `chains[noteId]` is `[hub, ...folder chain top-down, note]`.
  - `buildScene(inputs: SceneInput[], gap?: number): Scene`
  - `taperPath(points: Pt[], w0?: number, w1?: number): string`, a closed SVG path that is `w0` wide at the first point and `w1` wide at the last, or `''` when fewer than 2 distinct points.
  - `type Dir = 'left' | 'right' | 'up' | 'down'`, `arrowDir(key: string): Dir | null`.
  - `nearestInDirection(from: Pt, candidates: { id: string; x: number; y: number }[], dir: Dir): string | null`. This is the nearest candidate within ±45° of the direction (screen space, y down), skipping any at distance 0. Ties go to the smaller id.
  - `UNTITLED = 'Untitled'`, `displayTitle(title: string): string`.

- [ ] **Step 1: Write the failing tests `web/src/map/scene.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { layoutVault, layoutWorld } from './layout';
import { arrowDir, buildScene, displayTitle, nearestInDirection, taperPath, type SceneInput } from './scene';

function input(vaultId: string, bodies: Record<string, string> = {}, ready = true): SceneInput {
  const t = tree(
    [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
    [note(`${vaultId}-a`, 'f1', 'Alpha'), note(`${vaultId}-b`, 'f2', 'Beta'), note(`${vaultId}-c`, null, '  ')],
  );
  const graph = buildVaultGraph(vaultId, t, bodies, ready);
  return { vaultId, graph, layout: layoutVault(graph) };
}

describe('buildScene', () => {
  it('puts each hub at its world centre and offsets every dot from it', () => {
    const a = input('v1');
    const b = input('v2');
    const s = buildScene([a, b]);
    const centres = layoutWorld([a.layout, b.layout], 48);
    expect(s.hubs.map((h) => [h.vaultId, h.x, h.y])).toEqual([
      ['v1', centres.v1.x, centres.v1.y],
      ['v2', centres.v2.x, centres.v2.y],
    ]);
    const dot = s.dots.find((d) => d.id === 'v2-b')!;
    expect(dot.x).toBeCloseTo(centres.v2.x + b.layout.notes['v2-b'].x, 9);
  });

  it('draws one pencil line per folder and note, and chains hub → folders → note', () => {
    const s = buildScene([input('v1')]);
    expect(s.pencil).toHaveLength(2 + 3);
    const chain = s.chains['v1-b'];
    expect(chain).toHaveLength(4);
    expect(chain[0]).toEqual({ x: s.hubs[0].x, y: s.hubs[0].y });
    const f1 = s.folders.find((f) => f.id === 'f1')!;
    expect(chain[1]).toEqual({ x: f1.x, y: f1.y });
  });

  it('merges a two-way link into one line and counts neighbours', () => {
    const s = buildScene([input('v1', { 'v1-a': '[[beta]]', 'v1-b': '[[alpha]]' })]);
    expect(s.links).toHaveLength(1);
    expect(s.dots.find((d) => d.id === 'v1-a')!.links).toBe(1);
    expect(s.linksPending).toBe(false);
  });

  it('draws no links while note text is still decrypting', () => {
    const s = buildScene([input('v1', { 'v1-a': '[[beta]]' }, false)]);
    expect(s.links).toEqual([]);
    expect(s.linksPending).toBe(true);
  });

  it('names folder paths and labels untitled notes "Untitled" (Review Focus 5)', () => {
    const s = buildScene([input('v1')]);
    const by = (id: string) => s.dots.find((d) => d.id === id)!;
    expect(by('v1-b').folderPath).toBe('Ops / Runbooks');
    expect(by('v1-c').folderPath).toBe('');
    expect(by('v1-c').title).toBe('Untitled');
    expect(displayTitle(' x ')).toBe('x');
  });

  it('bounds cover every vault circle', () => {
    const s = buildScene([input('v1'), input('v2')]);
    for (const h of s.hubs) {
      expect(s.bounds.minX).toBeLessThanOrEqual(h.x - h.radius);
      expect(s.bounds.maxY).toBeGreaterThanOrEqual(h.y + h.radius);
      expect(s.vaultBounds[h.vaultId]).toEqual({ minX: h.x - h.radius, minY: h.y - h.radius, maxX: h.x + h.radius, maxY: h.y + h.radius });
    }
    expect(buildScene([]).bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('taperPath', () => {
  it('returns a closed outline with two points per vertex', () => {
    const d = taperPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 80, y: 40 }]);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.match(/L/g)).toHaveLength(5);
  });

  it('returns an empty path for fewer than two distinct points', () => {
    expect(taperPath([{ x: 1, y: 1 }])).toBe('');
    expect(taperPath([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBe('');
  });
});

describe('arrow-key navigation', () => {
  const pts = [
    { id: 'a', x: 10, y: 0 },
    { id: 'b', x: 5, y: 6 },
    { id: 'c', x: 30, y: 1 },
    { id: 'd', x: 1, y: -8 },
  ];
  it('finds the nearest dot within the 90° cone of the direction', () => {
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'right')).toBe('a');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'up')).toBe('d');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'left')).toBeNull();
  });
  it('maps arrow keys', () => {
    expect(arrowDir('ArrowLeft')).toBe('left');
    expect(arrowDir('ArrowDown')).toBe('down');
    expect(arrowDir('Enter')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- src/map/scene.test.ts`
Expected: FAIL. `./scene` cannot be resolved.

- [ ] **Step 3: Implement `web/src/map/scene.ts`**

```ts
import type { VaultGraph } from './graph';
import { layoutWorld, type Pt, type VaultLayout } from './layout';
import type { Bounds } from './useViewport';

export interface SceneInput {
  vaultId: string;
  graph: VaultGraph;
  layout: VaultLayout;
}
export interface SceneDot {
  id: string;
  vaultId: string;
  x: number;
  y: number;
  title: string;
  folderPath: string;
  updatedAt: string;
  links: number;
}
export interface SceneFolder {
  id: string;
  vaultId: string;
  x: number;
  y: number;
  name: string;
}
export interface SceneHub {
  vaultId: string;
  x: number;
  y: number;
  radius: number;
}
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
/** World-space geometry for every vault on the map. */
export interface Scene {
  dots: SceneDot[];
  folders: SceneFolder[];
  hubs: SceneHub[];
  pencil: Seg[];
  links: Seg[];
  /** Some vault's note text is still decrypting, so its links are not drawn yet. */
  linksPending: boolean;
  bounds: Bounds;
  vaultBounds: Record<string, Bounds>;
  /** Note id -> [hub, folders top-down, note], for ink strokes. */
  chains: Record<string, Pt[]>;
}

export const UNTITLED = 'Untitled';
export const displayTitle = (title: string) => title.trim() || UNTITLED;

const seg = (a: Pt, b: Pt): Seg => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

export function buildScene(inputs: SceneInput[], gap = 48): Scene {
  const centres = layoutWorld(
    inputs.map((i) => i.layout),
    gap,
  );
  const scene: Scene = {
    dots: [],
    folders: [],
    hubs: [],
    pencil: [],
    links: [],
    linksPending: false,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    vaultBounds: {},
    chains: {},
  };
  let first = true;

  for (const { vaultId, graph, layout } of inputs) {
    const c = centres[vaultId] ?? { x: 0, y: 0 };
    const at = (p: Pt): Pt => ({ x: c.x + p.x, y: c.y + p.y });
    const r = layout.radius;
    scene.hubs.push({ vaultId, x: c.x, y: c.y, radius: r });
    const vb = { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r };
    scene.vaultBounds[vaultId] = vb;
    scene.bounds = first
      ? { ...vb }
      : {
          minX: Math.min(scene.bounds.minX, vb.minX),
          minY: Math.min(scene.bounds.minY, vb.minY),
          maxX: Math.max(scene.bounds.maxX, vb.maxX),
          maxY: Math.max(scene.bounds.maxY, vb.maxY),
        };
    first = false;

    const folderById = new Map(graph.folders.map((f) => [f.id, f]));
    const pos = (id: string | null): Pt =>
      id === null ? { x: c.x, y: c.y } : at(layout.folders[id] ?? layout.notes[id] ?? { x: 0, y: 0 });
    const folderChain = (folderId: string | null): string[] => {
      const ids: string[] = [];
      for (let id = folderId; id && folderById.has(id); id = folderById.get(id)!.parentId) ids.unshift(id);
      return ids;
    };

    for (const f of graph.folders) {
      const p = layout.folders[f.id];
      if (p) scene.folders.push({ id: f.id, vaultId, ...at(p), name: f.name });
    }
    for (const [id, parent] of Object.entries(layout.parent)) scene.pencil.push(seg(pos(parent), pos(id)));

    const neighbours = new Map<string, Set<string>>();
    if (graph.linksReady) {
      const seen = new Set<string>();
      for (const l of graph.links) {
        if (!layout.notes[l.from] || !layout.notes[l.to]) continue;
        for (const [a, b] of [
          [l.from, l.to],
          [l.to, l.from],
        ]) {
          if (!neighbours.has(a)) neighbours.set(a, new Set());
          neighbours.get(a)!.add(b);
        }
        const key = l.from < l.to ? `${l.from}|${l.to}` : `${l.to}|${l.from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scene.links.push(seg(pos(l.from), pos(l.to)));
      }
    } else {
      scene.linksPending = true;
    }

    for (const n of graph.notes) {
      const p = layout.notes[n.id];
      if (!p) continue;
      const w = at(p);
      const chainIds = folderChain(n.folderId);
      scene.dots.push({
        id: n.id,
        vaultId,
        x: w.x,
        y: w.y,
        title: displayTitle(n.title),
        folderPath: chainIds.map((id) => folderById.get(id)!.name).join(' / '),
        updatedAt: n.updatedAt,
        links: neighbours.get(n.id)?.size ?? 0,
      });
      scene.chains[n.id] = [{ x: c.x, y: c.y }, ...chainIds.map((id) => pos(id)), w];
    }
  }
  return scene;
}

/** Closed outline of a stroke along `points`, `w0` wide at the start tapering to `w1`. */
export function taperPath(points: Pt[], w0 = 3, w1 = 0.8): string {
  const pts: Pt[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
  }
  if (pts.length < 2) return '';
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  const left: Pt[] = [];
  const right: Pt[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const half = (w0 + (w1 - w0) * (cum[i] / total)) / 2;
    left.push({ x: p.x + nx * half, y: p.y + ny * half });
    right.push({ x: p.x - nx * half, y: p.y - ny * half });
  });
  return [...left, ...right.reverse()].map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') + 'Z';
}

export type Dir = 'left' | 'right' | 'up' | 'down';
const KEYS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const VEC: Record<Dir, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

export const arrowDir = (key: string): Dir | null => KEYS[key] ?? null;

/** Nearest candidate within ±45° of `dir` from `from` (screen space, y down). */
export function nearestInDirection(from: Pt, candidates: { id: string; x: number; y: number }[], dir: Dir): string | null {
  const v = VEC[dir];
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    if ((dx * v.x + dy * v.y) / d < Math.SQRT1_2 - 1e-9) continue;
    if (d < bestDist || (d === bestDist && best !== null && c.id < best)) {
      best = c.id;
      bestDist = d;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w web -- src/map/scene.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/map/scene.ts web/src/map/scene.test.ts
git commit -m "feat(map): world scene, tapered ink paths and arrow-key navigation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Map entries hook, and backlinks from the graph

**Files:**
- Create: `web/src/map/useVaultGraphs.ts`
- Modify: `web/src/map/graph.ts` (append `structureKey`, `incomingLinks`), `web/src/pages/NotePane.tsx` (imports at lines 4 and 7; the `backlinks` `useMemo` at about lines 108–115), `docs/architecture.md` (after the "Links:" bullet, about line 177)
- Test: `web/src/map/useVaultGraphs.test.ts`, `web/src/map/graph.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1–4. `vaultStats(vault, tree, now?)` from `web/src/state/StoreContext.tsx`, which returns `{ level }`.
- Produces:
  - `structureKey(g: VaultGraph): string` changes only when a folder's id, parent or name changes, or a note's id, folder or title changes.
  - `incomingLinks(g: VaultGraph, noteId: string): GraphNote[]` returns the notes linking to `noteId`, sorted by title then id.
  - `interface MapEntry extends SceneInput { vault: VaultView; status: TreeView['status']; level: number }`
  - `type LayoutCache = Map<string, { key: string; layout: VaultLayout }>`
  - `type GraphState = Pick<AppState, 'vaultOrder' | 'vaults' | 'trees' | 'bodies' | 'bodiesReady'>`
  - `mapEntries(state: GraphState, cache: LayoutCache, now?: number): MapEntry[]` skips missing and broken vaults. A vault with no tree yet gets status `'loading'` and an empty graph.
  - `useVaultGraphs(state: AppState): MapEntry[]`
  - `useVaultGraph(state: AppState, vaultId: string): VaultGraph | null`

- [ ] **Step 1: Append failing tests to `web/src/map/graph.test.ts`**

Add `incomingLinks, structureKey` to the existing `./graph` import, then append:

```ts
describe('incomingLinks (backlinks)', () => {
  it('includes notes that link by [[title]] or by a root-relative /v/{vault}/n/{id} link, sorted by title', () => {
    const t = tree([], [note('target', null, 'Target'), note('w', null, 'Wiki'), note('m', null, 'Markdown'), note('x', null, 'Other')]);
    const g = buildVaultGraph('v1', t, { w: 'see [[target]]', m: 'see [it](/v/v1/n/target#top)', x: 'nothing' }, true);
    expect(incomingLinks(g, 'target').map((n) => n.id)).toEqual(['m', 'w']);
  });
});

describe('structureKey', () => {
  it('ignores edit times and links, but tracks titles, folders and parents', () => {
    const base = tree([folder('f1', null, 'A')], [note('n1', 'f1', 'One')]);
    const k = structureKey(buildVaultGraph('v1', base, {}, true));
    const touched = tree([folder('f1', null, 'A')], [note('n1', 'f1', 'One', { updatedAt: '2026-10-06T00:00:00.000Z' })]);
    expect(structureKey(buildVaultGraph('v1', touched, { n1: '[[One]]' }, true))).toBe(k);
    expect(structureKey(buildVaultGraph('v1', tree([folder('f1', null, 'A')], [note('n1', 'f1', 'Two')]), {}, true))).not.toBe(k);
    expect(structureKey(buildVaultGraph('v1', tree([folder('f1', null, 'B')], [note('n1', 'f1', 'One')]), {}, true))).not.toBe(k);
    expect(structureKey(buildVaultGraph('v1', tree([folder('f1', null, 'A')], [note('n1', null, 'One')]), {}, true))).not.toBe(k);
  });
});
```

- [ ] **Step 2: Write the failing tests `web/src/map/useVaultGraphs.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { folder, note, tree, vault } from './fixtures';
import { mapEntries, type GraphState, type LayoutCache } from './useVaultGraphs';

function state(over: Partial<GraphState> = {}): GraphState {
  return {
    vaultOrder: ['v1', 'v2', 'v3'],
    vaults: { v1: vault('v1'), v2: vault('v2'), v3: { ...vault('v3'), broken: true } },
    trees: { v1: tree([folder('f1', null)], [note('n1', 'f1', 'One')]) },
    bodies: {},
    bodiesReady: { v1: true },
    ...over,
  };
}

describe('mapEntries', () => {
  it('skips broken vaults and shows a vault with no tree yet as loading and empty', () => {
    const e = mapEntries(state(), new Map());
    expect(e.map((x) => [x.vaultId, x.status, x.graph.notes.length])).toEqual([
      ['v1', 'ready', 1],
      ['v2', 'loading', 0],
    ]);
    expect(e[0].graph.linksReady).toBe(true);
    expect(e[1].graph.linksReady).toBe(false);
  });

  it('reuses the cached layout when only bodies or edit times change', () => {
    const cache: LayoutCache = new Map();
    const first = mapEntries(state(), cache);
    const edited = state({
      trees: { v1: tree([folder('f1', null)], [note('n1', 'f1', 'One', { updatedAt: '2026-10-06T00:00:00.000Z' })]) },
      bodies: { n1: 'text' },
    });
    expect(mapEntries(edited, cache)[0].layout).toBe(first[0].layout);
    const renamed = state({ trees: { v1: tree([folder('f1', null)], [note('n1', 'f1', 'Renamed')]) } });
    expect(mapEntries(renamed, cache)[0].layout).not.toBe(first[0].layout);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w web -- src/map/graph.test.ts src/map/useVaultGraphs.test.ts`
Expected: FAIL. `incomingLinks`/`structureKey` are not exported, and `./useVaultGraphs` cannot be resolved.

- [ ] **Step 4: Append to `web/src/map/graph.ts`**

```ts
/** Changes only when something the layout depends on changes (not edit times or links). */
export function structureKey(g: VaultGraph): string {
  return JSON.stringify([g.folders.map((f) => [f.id, f.parentId, f.name]), g.notes.map((n) => [n.id, n.folderId, n.title])]);
}

/** Notes that link to `noteId` (backlinks), sorted by title. */
export function incomingLinks(g: VaultGraph, noteId: string): GraphNote[] {
  const from = new Set(g.links.filter((l) => l.to === noteId).map((l) => l.from));
  return g.notes.filter((n) => from.has(n.id)).sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
}
```

- [ ] **Step 5: Implement `web/src/map/useVaultGraphs.ts`**

```ts
import { useMemo, useRef } from 'react';
import { vaultStats } from '../state/StoreContext';
import type { AppState, TreeView, VaultView } from '../state/store';
import { buildVaultGraph, structureKey, type VaultGraph } from './graph';
import { layoutVault, type VaultLayout } from './layout';
import type { SceneInput } from './scene';

export interface MapEntry extends SceneInput {
  vault: VaultView;
  status: TreeView['status'];
  /** Ink level for the hub icon (share of notes edited this week). */
  level: number;
}
export type LayoutCache = Map<string, { key: string; layout: VaultLayout }>;
export type GraphState = Pick<AppState, 'vaultOrder' | 'vaults' | 'trees' | 'bodies' | 'bodiesReady'>;

const EMPTY_TREE: TreeView = { status: 'loading', folders: {}, notes: {} };

/** One entry per usable vault, in sidebar order. Layouts are reused until the folder/note structure changes. */
export function mapEntries(state: GraphState, cache: LayoutCache, now = Date.now()): MapEntry[] {
  const out: MapEntry[] = [];
  for (const id of state.vaultOrder) {
    const vault = state.vaults[id];
    if (!vault || vault.broken) continue;
    const tree = state.trees[id] ?? EMPTY_TREE;
    const graph = buildVaultGraph(id, tree, state.bodies, !!state.bodiesReady[id]);
    const key = structureKey(graph);
    let hit = cache.get(id);
    if (!hit || hit.key !== key) {
      hit = { key, layout: layoutVault(graph) };
      cache.set(id, hit);
    }
    out.push({ vaultId: id, vault, status: tree.status, level: vaultStats(vault, state.trees[id], now).level, graph, layout: hit.layout });
  }
  return out;
}

export function useVaultGraphs(state: AppState): MapEntry[] {
  const cache = useRef<LayoutCache>(new Map());
  const { vaultOrder, vaults, trees, bodies, bodiesReady } = state;
  return useMemo(
    () => mapEntries({ vaultOrder, vaults, trees, bodies, bodiesReady }, cache.current),
    [vaultOrder, vaults, trees, bodies, bodiesReady],
  );
}

/** The link graph of one vault, or null before its tree has loaded. */
export function useVaultGraph(state: AppState, vaultId: string): VaultGraph | null {
  const tree = state.trees[vaultId];
  const ready = !!state.bodiesReady[vaultId];
  const { bodies } = state;
  return useMemo(() => (tree ? buildVaultGraph(vaultId, tree, bodies, ready) : null), [vaultId, tree, bodies, ready]);
}
```

- [ ] **Step 6: Switch `NotePane` backlinks to the graph**

In `web/src/pages/NotePane.tsx`:
- Change the markdown import to `import { renderMarkdown, toggleTaskAtLine } from '../markdown/render';` (drop `wikiLinkTargets`).
- Add these imports:

```ts
import { incomingLinks } from '../map/graph';
import { useVaultGraph } from '../map/useVaultGraphs';
```

- Replace the whole `const backlinks = useMemo(() => { … }, [head, tree, noteId, state.bodies]);` block with:

```ts
  const graph = useVaultGraph(state, vault.id);
  const backlinks = useMemo(() => (graph ? incomingLinks(graph, noteId) : []), [graph, noteId]);
```

The JSX that renders `backlinks` is unchanged. It uses `n.id` and `n.title`, which `GraphNote` has.

- [ ] **Step 7: Document the shared link graph in `docs/architecture.md`**

Insert directly after the bullet that starts with `- Links: only root-relative Markdown links` (about line 177):

```markdown
- Link graph: backlinks and the concept map share one graph (`web/src/map/graph.ts`), built in the browser from decrypted note bodies. It counts `[[wiki-links]]` (resolved by title; on duplicate titles the most recently edited note wins) and root-relative `/v/{vaultId}/n/{noteId}` Markdown links within the same vault. Nothing about the graph or the map is sent to the server or stored.
```

- [ ] **Step 8: Run the tests, the full suite and the build**

Run: `npm test -w web -- src/map/graph.test.ts src/map/useVaultGraphs.test.ts`
Expected: PASS.
Run: `npm test -w web` then `npm run build -w web`
Expected: all pass (the existing NotePane tests included); the build succeeds with no unused-import errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/map/graph.ts web/src/map/graph.test.ts web/src/map/useVaultGraphs.ts web/src/map/useVaultGraphs.test.ts web/src/pages/NotePane.tsx docs/architecture.md
git commit -m "feat(map): cached map entries; backlinks come from the shared link graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Home concept map

**Files:**
- Create: `web/src/map/ConceptMap.tsx`, `web/src/map/MapSlip.tsx`, `web/src/styles/map.css`
- Modify: `web/src/styles/tokens.css` (the `:root` block), `web/src/components/Icons.tsx` (after `PlusIcon`), `web/src/pages/HomePage.tsx`, `web/src/styles/home.css` (delete the `.map-placeholder` and `.map-placeholder p` rules), `web/src/main.tsx` (CSS imports), `docs/architecture.md` (lines 3 and 166)
- Test: `web/src/map/ConceptMap.test.tsx`

**Interfaces:**
- Consumes:
  - `MapEntry` and `useVaultGraphs` (Task 5);
  - `buildScene`, `taperPath`, `nearestInDirection`, `arrowDir`, `SceneDot` (Task 4);
  - `useViewport`, `fit`, `zoomAt`, `panBy`, `toScreen`, `Size` (Task 3);
  - `inkTier` (Task 1);
  - `VaultIcon({ color, level, size })` from `web/src/brand/VaultIcon.tsx`;
  - `relativeTime(iso, now?)` from `web/src/lib/util.ts`.
- Produces:
  - `ConceptMap(props: ConceptMapProps)` with `ConceptMapProps = { entries: MapEntry[]; hits: ReadonlySet<string>; hot: string | null; loading: boolean; now?: number }`
  - `MapLegend({ linksPending }: { linksPending: boolean })`
  - `noteHref(vaultId, noteId): string`
  - `MapSlip(props)`
  - Icons `MinusIcon`, `FitIcon`
  - CSS classes used again in Task 7: `.cmap-pencil line`, `.cmap-links line`, `.cmap-node`, `.cmap-hit`, `.cmap-dot.tier-*`, `.cmap-label`

DOM contract (the tests rely on it):
- **Frame:** `div.cmap` holds `svg.cmap-svg` (`role="group"`, `aria-label="Concept map of all vaults"`).
- **Dots:**
  - each dot is `g.cmap-node`, with `data-note={id}`, `role="button"` and `transform="translate(x y)"`;
  - `tabindex` is `0` on exactly one dot (the roving dot) and `-1` on the rest;
  - a dot gets class `is-faded` when a search is active and it is not inked.
- **Slip:** `div.cmap-slip`.
- **Hub caption:** `text.cmap-hub-note` reading "Couldn’t load".
- **Loading message:** `p.cmap-msg` reading "Decrypting your notes…".

- [ ] **Step 1: Add tokens and icons**

In `web/src/styles/tokens.css`, inside `:root` after the `/* Ink */` group:

```css
  /* Concept map: wet → dry is an ordinal one-hue ramp (validated against --canvas) */
  --ink-wet: #b69cff;
  --ink-fresh: #9d7cf2;
  --ink-drying: #6b5a9e;
  --ink-dry: #524b6e;
  --map-pencil: #4a4659;
  --map-ink: #9d7cf2;
  --map-sel: #ede9ff;
```

In `web/src/components/Icons.tsx`, after `PlusIcon`:

```tsx
export const MinusIcon = (p: P) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M5 12h14" />
  </Svg>
);
export const FitIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
```

- [ ] **Step 2: Write the failing tests `web/src/map/ConceptMap.test.tsx`**

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoteView, TreeView } from '../state/store';
import { ConceptMap, type ConceptMapProps } from './ConceptMap';
import { folder, note, tree, vault } from './fixtures';
import { buildVaultGraph } from './graph';
import { layoutVault } from './layout';
import { buildScene, nearestInDirection } from './scene';
import type { MapEntry } from './useVaultGraphs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function entry(t: TreeView, id = 'v1'): MapEntry {
  const graph = buildVaultGraph(id, t, {}, true);
  return { vaultId: id, vault: vault(id), status: t.status, level: 0, graph, layout: layoutVault(graph) };
}
const base = () =>
  tree(
    [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
    [note('n1', 'f1', 'Alpha'), note('n2', 'f2', 'Beta'), note('n3', null, 'Gamma'), note('n4', 'f1', 'Delta', { broken: true })],
  );

let root: Root | null = null;
let host: HTMLElement | null = null;

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function ui(p: Partial<ConceptMapProps> & { entries: MapEntry[] }) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ConceptMap hits={new Set()} hot={null} loading={false} now={NOW} {...p} />} />
        <Route path="/v/:v/n/:n" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}
function render(p: Partial<ConceptMapProps> & { entries: MapEntry[] }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui(p)));
  return { rerender: (q: Partial<ConceptMapProps> & { entries: MapEntry[] }) => act(() => root!.render(ui(q))) };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const nodes = () => [...host!.querySelectorAll<SVGGElement>('g.cmap-node')];
const node = (id: string) => host!.querySelector<SVGGElement>(`g.cmap-node[data-note="${id}"]`)!;
const svg = () => host!.querySelector<SVGSVGElement>('svg.cmap-svg')!;
const fire = (el: Element, ev: Event) => act(() => void el.dispatchEvent(ev));
const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true }));
const key = (el: Element, k: string) => fire(el, new KeyboardEvent('keydown', { key: k, bubbles: true }));
const pointer = (type: string, x: number, y: number) =>
  fire(svg(), new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
const translate = (el: Element) => {
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el.getAttribute('transform') ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

describe('ConceptMap', () => {
  it('draws one dot per non-broken note', () => {
    render({ entries: [entry(base())] });
    expect(nodes().map((n) => n.dataset.note).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('clicking a dot selects it and shows the slip', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    const slip = host!.querySelector('.cmap-slip');
    expect(slip?.textContent).toContain('Alpha');
    expect(slip?.textContent).toContain('Ops');
    expect(slip?.textContent).toContain('Open note →');
  });

  it('Enter on a dot opens the note', () => {
    render({ entries: [entry(base())] });
    key(node('n2'), 'Enter');
    expect(host!.querySelector('[data-testid="where"]')?.textContent).toBe('/v/v1/n/n2');
  });

  it('Escape clears the selection', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    key(node('n1'), 'Escape');
    expect(host!.querySelector('.cmap-slip')).toBeNull();
  });

  it('a search fades the notes that do not match', () => {
    render({ entries: [entry(base())], hits: new Set(['n1']) });
    expect(node('n1').classList.contains('is-faded')).toBe(false);
    expect(node('n2').classList.contains('is-faded')).toBe(true);
    expect(host!.querySelectorAll('.cmap-ink path').length).toBe(1);
  });

  it('ArrowRight moves the roving focus to the nearest dot on the right', () => {
    const ring = tree([], Array.from({ length: 8 }, (_, i) => note(`r${i}`, null, `r${i}`)) as NoteView[]);
    const e = entry(ring);
    render({ entries: [e] });
    const dots = buildScene([e]).dots;
    const leftmost = dots.reduce((a, b) => (b.x < a.x ? b : a));
    const expected = nearestInDirection(leftmost, dots, 'right');
    expect(expected).not.toBeNull();
    fire(node(leftmost.id), new FocusEvent('focusin', { bubbles: true }));
    key(node(leftmost.id), 'ArrowRight');
    expect(node(expected!).getAttribute('tabindex')).toBe('0');
    expect(nodes().filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('a drag pans the map and does not select the dot it ends on (Review Focus 4)', () => {
    render({ entries: [entry(base())] });
    const before = translate(node('n1'))!;
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 130, 110);
    pointer('pointerup', 130, 110);
    click(node('n1'));
    expect(host!.querySelector('.cmap-slip')).toBeNull();
    const after = translate(node('n1'))!;
    expect(after.x - before.x).toBeCloseTo(30, 0);
    expect(after.y - before.y).toBeCloseTo(10, 0);
  });

  it('refits when a loading vault becomes ready (Review Focus 3)', () => {
    const { rerender } = render({ entries: [entry(tree([], [], 'loading'))], loading: true });
    expect(host!.querySelector('.cmap-msg')?.textContent).toBe('Decrypting your notes…');
    rerender({ entries: [entry(base())], loading: false });
    expect(host!.querySelector('.cmap-msg')).toBeNull();
    for (const n of nodes()) {
      const p = translate(n)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(480);
    }
  });

  it('shows an empty vault as a hub alone, and says when a vault failed to load', () => {
    render({ entries: [entry(tree([], [])), entry(tree([], [], 'error'), 'v2')] });
    expect(nodes()).toHaveLength(0);
    expect(host!.textContent).toContain('Vault v1');
    expect(host!.querySelector('.cmap-hub-note')?.textContent).toBe('Couldn’t load');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w web -- src/map/ConceptMap.test.tsx`
Expected: FAIL. `./ConceptMap` cannot be resolved.

- [ ] **Step 4: Implement `web/src/map/MapSlip.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { relativeTime } from '../lib/util';
import type { SceneDot } from './scene';
import type { Size } from './useViewport';

const W = 220;
const H = 96;
const PAD = 8;

/** Card for the selected dot, kept inside the map frame. */
export function MapSlip({ dot, x, y, frame, href, now }: { dot: SceneDot; x: number; y: number; frame: Size; href: string; now: number }) {
  const left = Math.max(PAD, Math.min(x + 12, frame.w - W - PAD));
  const top = Math.max(PAD, Math.min(y - 20, frame.h - H - PAD));
  return (
    <div className="cmap-slip" style={{ left, top }} role="group" aria-label="Selected note">
      <div className="cmap-slip-title">{dot.title}</div>
      <div className="cmap-slip-path">{dot.folderPath || 'Vault root'}</div>
      <div className="cmap-slip-meta">
        edited {relativeTime(dot.updatedAt, now)} · {dot.links} {dot.links === 1 ? 'link' : 'links'}
      </div>
      <Link className="cmap-slip-open" to={href}>
        Open note →
      </Link>
    </div>
  );
}
```

- [ ] **Step 5: Implement `web/src/map/ConceptMap.tsx`**

```tsx
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { VaultIcon } from '../brand/VaultIcon';
import { FitIcon, MinusIcon, PlusIcon } from '../components/Icons';
import { relativeTime } from '../lib/util';
import { MapSlip } from './MapSlip';
import { inkTier } from './recency';
import { arrowDir, buildScene, nearestInDirection, taperPath } from './scene';
import { fit, panBy, toScreen, useViewport, zoomAt, type Size } from './useViewport';
import type { MapEntry } from './useVaultGraphs';

const FALLBACK: Size = { w: 800, h: 480 };
const DRAG_PX = 4;
const LABEL_SCALE = 1.6;
const STEP = 1.25;
const EDGE = 16;

export const noteHref = (vaultId: string, noteId: string) => `/v/${vaultId}/n/${noteId}`;

export interface ConceptMapProps {
  entries: MapEntry[];
  /** Note ids matching the current search. */
  hits: ReadonlySet<string>;
  /** Note under the pointer or focus in the results list. */
  hot: string | null;
  loading: boolean;
  now?: number;
}

const f1 = (n: number) => n.toFixed(1);

export function ConceptMap({ entries, hits, hot, loading, now = Date.now() }: ConceptMapProps) {
  const navigate = useNavigate();
  const uid = 'cm' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dotRefs = useRef(new Map<string, SVGGElement>());
  const [size, setSize] = useState<Size>(FALLBACK);
  const scene = useMemo(() => buildScene(entries), [entries]);
  const { view, setView, animateTo } = useViewport(() => fit(scene.bounds, FALLBACK));
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const touched = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinch = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const entryById = useMemo(() => new Map(entries.map((e) => [e.vaultId, e])), [entries]);
  const dotById = useMemo(() => new Map(scene.dots.map((d) => [d.id, d])), [scene]);
  const sel = selected && dotById.has(selected) ? selected : null;

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((items) => {
      const r = items[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit on mount, when the vault set changes, and when a vault finishes loading, unless the user has moved the map.
  const idKey = entries.map((e) => e.vaultId).join(',');
  const statusKey = entries.map((e) => `${e.vaultId}:${e.status}`).join(',');
  useEffect(() => {
    touched.current = false;
  }, [idKey]);
  useEffect(() => {
    if (!touched.current) setView(fit(scene.bounds, size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey, size.w, size.h]);

  // Wheel zoom needs a non-passive listener so the page does not scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const r = el.getBoundingClientRect();
      touched.current = true;
      setView((v) => zoomAt(v, Math.pow(1.0015, -dy), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    suppressClick.current = false;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) drag.current = { x: p.x, y: p.y, moved: false };
    else {
      pinch.current = null;
      if (drag.current) drag.current.moved = true;
    }
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current && d > 0) {
        const factor = d / pinch.current;
        touched.current = true;
        setView((v) => zoomAt(v, factor, (a.x + b.x) / 2, (a.y + b.y) / 2));
      }
      pinch.current = d;
      return;
    }
    const g = drag.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.hypot(p.x - g.x, p.y - g.y) < DRAG_PX) return;
      g.moved = true;
      setDragging(true);
      svgRef.current?.setPointerCapture?.(e.pointerId);
      touched.current = true;
      setView((v) => panBy(v, p.x - g.x, p.y - g.y));
      return;
    }
    touched.current = true;
    setView((v) => panBy(v, p.x - prev.x, p.y - prev.y));
  };
  const onPointerEnd = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      suppressClick.current = drag.current?.moved ?? false;
      drag.current = null;
      setDragging(false);
    }
  };
  /** True (once) when the click that follows is the end of a drag. */
  const consumeDrag = () => {
    const moved = suppressClick.current;
    suppressClick.current = false;
    return moved;
  };

  const zoomBy = (factor: number) => {
    touched.current = true;
    animateTo(zoomAt(view, factor, size.w / 2, size.h / 2));
  };
  const fitAll = () => {
    touched.current = false;
    animateTo(fit(scene.bounds, size));
  };

  const shown = useMemo(() => scene.dots.map((dot) => ({ dot, ...toScreen(view, dot) })), [scene, view]);
  const firstHit = useMemo(() => {
    for (const id of hits) if (dotById.has(id)) return id;
    return null;
  }, [hits, dotById]);
  const recentId = useMemo(
    () => scene.dots.reduce<string | null>((best, d) => (best === null || d.updatedAt > dotById.get(best)!.updatedAt ? d.id : best), null),
    [scene, dotById],
  );
  const rovingId = (focusId && dotById.has(focusId) ? focusId : null) ?? sel ?? firstHit ?? recentId;

  const focusDot = (id: string) => {
    setFocusId(id);
    const d = dotById.get(id);
    if (d) {
      const s = toScreen(view, d);
      if (s.x < EDGE || s.y < EDGE || s.x > size.w - EDGE || s.y > size.h - EDGE) {
        touched.current = true;
        animateTo(panBy(view, size.w / 2 - s.x, size.h / 2 - s.y));
      }
    }
    dotRefs.current.get(id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const dir = arrowDir(e.key);
    if (dir) {
      e.preventDefault();
      const from = shown.find((s) => s.dot.id === rovingId);
      if (!from) return;
      const next = nearestInDirection(
        from,
        shown.map((s) => ({ id: s.dot.id, x: s.x, y: s.y })),
        dir,
      );
      if (next) focusDot(next);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      zoomBy(1 / STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      fitAll();
    } else if (e.key === 'Escape' && sel) {
      e.preventDefault();
      setSelected(null);
    }
  };
  const onDotKey = (e: KeyboardEvent<SVGGElement>, vaultId: string, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      navigate(noteHref(vaultId, id));
    }
  };
  const onDotClick = (e: MouseEvent<SVGGElement>, id: string) => {
    e.stopPropagation();
    if (consumeDrag()) return;
    setSelected(id);
    setFocusId(id);
  };
  const onHubClick = (e: MouseEvent<SVGGElement>, vaultId: string) => {
    e.stopPropagation();
    if (consumeDrag()) return;
    const b = scene.vaultBounds[vaultId];
    if (!b) return;
    touched.current = true;
    animateTo(fit(b, size));
  };
  const onBackgroundClick = () => {
    if (consumeDrag()) return;
    setSelected(null);
  };

  const inked = new Set<string>();
  for (const id of hits) if (dotById.has(id)) inked.add(id);
  if (sel) inked.add(sel);
  if (hot && dotById.has(hot)) inked.add(hot);
  const searching = hits.size > 0;
  const line = (s: { x1: number; y1: number; x2: number; y2: number }, i: number) => {
    const a = toScreen(view, { x: s.x1, y: s.y1 });
    const b = toScreen(view, { x: s.x2, y: s.y2 });
    return <line key={i} x1={f1(a.x)} y1={f1(a.y)} x2={f1(b.x)} y2={f1(b.y)} />;
  };
  const selDot = sel ? dotById.get(sel)! : null;
  const selAt = selDot ? toScreen(view, selDot) : null;

  return (
    <div className="cmap" ref={frameRef}>
      <svg
        ref={svgRef}
        className={`cmap-svg${dragging ? ' is-dragging' : ''}`}
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        role="group"
        aria-label="Concept map of all vaults"
        aria-describedby={`${uid}-help`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onBackgroundClick}
        onKeyDown={onKeyDown}
      >
        <defs>
          <filter id={`${uid}-glow`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>
        <g className="cmap-pencil">{scene.pencil.map(line)}</g>
        <g className="cmap-links">{scene.links.map(line)}</g>
        <g className="cmap-ink">
          {[...inked].map((id) => (
            <path key={id} d={taperPath(scene.chains[id].map((p) => toScreen(view, p)))} />
          ))}
        </g>
        <g className="cmap-folders">
          {scene.folders.map((f) => {
            const s = toScreen(view, f);
            return (
              <text key={f.id} x={f1(s.x)} y={f1(s.y + 3.5)} textAnchor="middle">
                {f.name}
              </text>
            );
          })}
        </g>
        <g className="cmap-hubs">
          {scene.hubs.map((h) => {
            const e = entryById.get(h.vaultId);
            if (!e) return null;
            const s = toScreen(view, h);
            return (
              <g key={h.vaultId} className="cmap-hub" transform={`translate(${f1(s.x)} ${f1(s.y)})`} onClick={(ev) => onHubClick(ev, h.vaultId)} aria-hidden="true">
                <g transform="translate(-7 -7)">
                  <VaultIcon color={e.vault.color} level={e.level} size={14} />
                </g>
                <text className="cmap-hub-name" x={11} y={4.5}>
                  {e.vault.name}
                </text>
                {e.status === 'error' && (
                  <text className="cmap-hub-note" x={11} y={19}>
                    Couldn’t load
                  </text>
                )}
              </g>
            );
          })}
        </g>
        <g className="cmap-dots">
          {shown.map(({ dot, x, y }) => {
            const tier = inkTier(dot.updatedAt, now);
            const active = dot.id === hover || dot.id === focusId;
            const big = dot.id === sel || dot.id === hot || active;
            const r = big ? 5 : 4;
            const when = relativeTime(dot.updatedAt, now);
            const showLabel = view.scale >= LABEL_SCALE || inked.has(dot.id) || active;
            return (
              <g
                key={dot.id}
                ref={(el) => {
                  if (el) dotRefs.current.set(dot.id, el);
                  else dotRefs.current.delete(dot.id);
                }}
                className={`cmap-node${searching && !inked.has(dot.id) ? ' is-faded' : ''}`}
                data-note={dot.id}
                transform={`translate(${f1(x)} ${f1(y)})`}
                role="button"
                tabIndex={dot.id === rovingId ? 0 : -1}
                aria-label={`${dot.title}, ${dot.folderPath || 'vault root'}, edited ${when}`}
                onClick={(e) => onDotClick(e, dot.id)}
                onKeyDown={(e) => onDotKey(e, dot.vaultId, dot.id)}
                onFocus={() => setFocusId(dot.id)}
                onPointerEnter={() => setHover(dot.id)}
                onPointerLeave={() => setHover((h) => (h === dot.id ? null : h))}
              >
                <circle className="cmap-hit" r={12} />
                {(tier === 'wet' || tier === 'fresh') && <circle className={`cmap-glow tier-${tier}`} r={r + 3} filter={`url(#${uid}-glow)`} />}
                <circle className={`cmap-dot tier-${tier}`} r={r} />
                {dot.id === sel && <circle className="cmap-sel" r={r + 3} />}
                {showLabel && (
                  <text className="cmap-label" x={r + 5} y={3.5}>
                    {active ? `${dot.title} · ${when}` : dot.title}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="cmap-tools">
        <button type="button" className="cmap-btn" aria-label="Zoom in" onClick={() => zoomBy(STEP)}>
          <PlusIcon size={12} />
        </button>
        <button type="button" className="cmap-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / STEP)}>
          <MinusIcon size={12} />
        </button>
        <button type="button" className="cmap-btn" aria-label="Fit map" onClick={fitAll}>
          <FitIcon size={12} />
        </button>
      </div>

      {selDot && selAt && <MapSlip dot={selDot} x={selAt.x} y={selAt.y} frame={size} href={noteHref(selDot.vaultId, selDot.id)} now={now} />}
      {loading && scene.dots.length === 0 && <p className="cmap-msg">Decrypting your notes…</p>}
      <p id={`${uid}-help`} className="sr-only">
        Arrow keys move between notes. Enter opens a note. Plus and minus zoom, 0 fits the map, Escape clears the selection.
      </p>
    </div>
  );
}

export function MapLegend({ linksPending }: { linksPending: boolean }) {
  return (
    <div className="cmap-legend">
      <span>
        <i className="lg-pencil" aria-hidden="true" />
        pencil: folder lines at rest
      </span>
      <span>
        <i className="lg-ink" aria-hidden="true" />
        ink: your search and selected note
      </span>
      <span>
        <i className="lg-dot tier-wet" aria-hidden="true" />
        <i className="lg-dot tier-fresh" aria-hidden="true" />
        <i className="lg-dot tier-drying" aria-hidden="true" />
        <i className="lg-dot tier-dry" aria-hidden="true" />
        wet → dry: today, this week, this month, older
      </span>
      <span>
        <i className="lg-link" aria-hidden="true" />
        [[links]]
      </span>
      {linksPending && <span className="lg-note">Links appear once note text is decrypted.</span>}
    </div>
  );
}
```

- [ ] **Step 6: Add `web/src/styles/map.css` and import it**

```css
/* Concept map (Home) and local map (note page). Colours come from tokens.css. */
.map {
  flex: 999 1 520px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cmap {
  position: relative;
  aspect-ratio: 100 / 60;
  min-height: 320px;
  background: var(--canvas);
  border: 1px solid var(--side-border);
  border-radius: 10px;
  overflow: hidden;
}
.cmap-svg {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.cmap-svg.is-dragging {
  cursor: grabbing;
}
.cmap-svg:focus {
  outline: none;
}

.cmap-pencil line {
  stroke: var(--map-pencil);
  stroke-width: 1;
}
.cmap-links line {
  stroke: var(--map-pencil);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.cmap-ink path {
  fill: var(--map-ink);
  opacity: 0.9;
}

.cmap-node {
  cursor: pointer;
}
.cmap-node:focus {
  outline: none;
}
.cmap-node.is-faded {
  opacity: 0.3;
}
.cmap-hit {
  fill: transparent;
}
.cmap-node:focus-visible .cmap-hit {
  stroke: var(--map-sel);
  stroke-width: 1.5;
}
/* 2px surface ring keeps dots legible where they cross lines. */
.cmap-dot {
  stroke: var(--canvas);
  stroke-width: 4;
  paint-order: stroke;
}
.cmap-dot.tier-wet,
.cmap-glow.tier-wet {
  fill: var(--ink-wet);
}
.cmap-dot.tier-fresh,
.cmap-glow.tier-fresh {
  fill: var(--ink-fresh);
}
.cmap-dot.tier-drying {
  fill: var(--ink-drying);
}
.cmap-dot.tier-dry {
  fill: var(--ink-dry);
}
.cmap-glow.tier-wet {
  opacity: 0.38;
}
.cmap-glow.tier-fresh {
  opacity: 0.22;
}
.cmap-sel {
  fill: none;
  stroke: var(--map-sel);
  stroke-width: 1.5;
}

.cmap-label,
.cmap-folders text,
.cmap-hub-name {
  paint-order: stroke;
  stroke: var(--canvas);
  stroke-linejoin: round;
  pointer-events: none;
}
.cmap-label {
  font: 500 10.5px var(--font-ui);
  fill: var(--text);
  stroke-width: 3px;
}
.cmap-folders text {
  font: 500 10.5px var(--font-ui);
  fill: var(--muted);
  stroke-width: 4px;
}
.cmap-hub {
  cursor: zoom-in;
}
.cmap-hub-name {
  font: italic 500 13px var(--font-serif);
  fill: var(--text);
  stroke-width: 4px;
}
.cmap-hub-note {
  font: 500 10.5px var(--font-ui);
  fill: var(--muted-3);
}

.cmap-tools {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
}
.cmap-btn {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--side-border);
  border-radius: 6px;
  background: var(--canvas);
  color: var(--muted);
  cursor: pointer;
}
.cmap-btn:hover {
  color: var(--text);
  background: var(--hover);
}
.cmap-btn:focus-visible {
  outline: 2px solid var(--ink-light);
  outline-offset: 1px;
}
.cmap-msg {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  font-size: 12.5px;
  color: var(--muted-3);
  pointer-events: none;
}

.cmap-slip {
  position: absolute;
  width: 220px;
  box-sizing: border-box;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.cmap-slip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}
.cmap-slip-path {
  font-size: 11.5px;
  color: var(--muted);
}
.cmap-slip-meta {
  font-size: 11.5px;
  color: var(--muted-2);
}
.cmap-slip-open {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-light);
  text-decoration: none;
}
.cmap-slip-open:hover {
  text-decoration: underline;
}

.cmap-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  font-size: 11px;
  color: var(--muted-3);
}
.cmap-legend > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.lg-pencil,
.lg-link {
  width: 18px;
  border-top: 1px solid var(--map-pencil);
}
.lg-link {
  border-top-style: dashed;
}
.lg-ink {
  width: 18px;
  height: 3px;
  background: var(--map-ink);
  clip-path: polygon(0 0, 100% 38%, 100% 62%, 0 100%);
}
.lg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.lg-dot.tier-wet {
  background: var(--ink-wet);
}
.lg-dot.tier-fresh {
  background: var(--ink-fresh);
}
.lg-dot.tier-drying {
  background: var(--ink-drying);
}
.lg-dot.tier-dry {
  background: var(--ink-dry);
}
.lg-note {
  color: var(--muted-2);
}
```

In `web/src/main.tsx`, add `import './styles/map.css';` after `import './styles/home.css';`. In `web/src/styles/home.css`, delete the `.map-placeholder { … }` and `.map-placeholder p { … }` rules.

- [ ] **Step 7: Wire the map into `web/src/pages/HomePage.tsx`**

Add these imports:

```ts
import { ConceptMap, MapLegend } from '../map/ConceptMap';
import { useVaultGraphs } from '../map/useVaultGraphs';
```

After `const bodyHits = useMemo(…)`, add:

```ts
  const mapEntries = useVaultGraphs(state);
  const hitIds = useMemo(() => new Set([...titleHits, ...bodyHits].map((h) => h.entry.noteId)), [titleHits, bodyHits]);
  const [hot, setHot] = useState<string | null>(null);
  const hotFrom = (t: EventTarget) => (t instanceof Element ? t.closest('a.res')?.getAttribute('data-note') ?? null : null);
```

Replace the placeholder section:

```tsx
        <section className="map-placeholder" aria-label="Concept map">
          <p>Concept map arrives in the next build</p>
        </section>
```

with:

```tsx
        {(state.vaultsStatus !== 'ready' || vaults.length > 0) && (
          <section className="map" aria-label="Concept map">
            <ConceptMap entries={mapEntries} hits={hitIds} hot={hot} loading={treesPending} />
            <MapLegend linksPending={mapEntries.some((e) => !e.graph.linksReady)} />
          </section>
        )}
```

On the `<aside className="results" …>` element, add:

```tsx
          onMouseOver={(e) => setHot(hotFrom(e.target))}
          onMouseLeave={() => setHot(null)}
          onFocus={(e) => setHot(hotFrom(e.target))}
          onBlur={() => setHot(null)}
```

Add `data-note={entry.noteId}` to each of the three `<Link className="res" …>` elements: title hits, body hits and recent.

- [ ] **Step 8: Update `docs/architecture.md`**

- Line 3: replace "The concept map comes in round 2." with "Round 2 adds the concept map (`docs/superpowers/specs/2026-10-07-concept-map-design.md`)."
- Line 166: replace "(home: search + results + vault list; map placeholder for round 2)" with "(home: search + results + concept map of every vault)".

- [ ] **Step 9: Run the tests, the full suite and the build**

Run: `npm test -w web -- src/map/ConceptMap.test.tsx`
Expected: PASS (9 tests).
Run: `npm test -w web` then `npm run build -w web`
Expected: all pass; the build succeeds.

- [ ] **Step 10: Commit**

```bash
git add web/src/map/ConceptMap.tsx web/src/map/ConceptMap.test.tsx web/src/map/MapSlip.tsx web/src/styles/map.css web/src/styles/tokens.css web/src/styles/home.css web/src/components/Icons.tsx web/src/pages/HomePage.tsx web/src/main.tsx docs/architecture.md
git commit -m "feat(map): Home concept map with pan/zoom, search ink, wet/dry dots and keyboard navigation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Local map on the note page

**Files:**
- Create: `web/src/map/localGraph.ts`, `web/src/map/LocalMap.tsx`
- Modify: `web/src/styles/map.css` (append), `web/src/pages/NotePane.tsx` (the `aside.ctx`, before the Backlinks section; also the `StoreContext` import)
- Test: `web/src/map/localGraph.test.ts`, `web/src/map/LocalMap.test.tsx`

**Interfaces:**
- Consumes: `VaultGraph`, `GraphNote`, `GraphFolder`, `buildVaultGraph` (Task 1); `arrowDir`, `nearestInDirection`, `displayTitle` (Task 4); `inkTier` (Task 1); `useVaultGraph` (Task 5) and the `graph` const it adds to `NotePane`; CSS classes `.cmap-pencil`, `.cmap-links`, `.cmap-node`, `.cmap-hit`, `.cmap-dot.tier-*`, `.cmap-label` (Task 6); `VaultIcon`; `vaultStats` from `StoreContext`.
- Produces:
  - `LOCAL_CAP = 12`
  - `interface LocalGraph { center: GraphNote; parent: { kind: 'folder'; folder: GraphFolder } | { kind: 'hub' }; siblings: GraphNote[]; siblingsMore: number; outgoing: GraphNote[]; outgoingMore: number; incoming: GraphNote[]; incomingMore: number }`
  - `localGraph(graph: VaultGraph, noteId: string): LocalGraph | null`
  - `LocalMap({ graph, noteId, vaultName, vaultColor, level, now? })`

DOM contract (the tests rely on it):
- **Frame:** `div.lmap` holds `svg.lmap-svg`.
- **Rows:** each neighbour row is `g.cmap-node`, with `data-note={id}`, `data-kind="incoming" | "siblings" | "outgoing"` and `role="link"`.
- **Columns:** at x 12 (incoming), 117 (siblings) and 222 (outgoing). Row y = `106 + i × 11.5`.
- **More label:** `text.lmap-more` reads `+N more`.
- **Message:** `p.lmap-msg` reads "Drawing links…" or "No neighbours yet".

- [ ] **Step 1: Write the failing tests `web/src/map/localGraph.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { LOCAL_CAP, localGraph } from './localGraph';

const at = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString();

describe('localGraph', () => {
  it('caps each group at 12, most recently edited first, and counts the rest', () => {
    const sibs = Array.from({ length: 15 }, (_, i) => note(`s${i}`, 'f1', `s${i}`, { updatedAt: at(i) }));
    const g = buildVaultGraph('v1', tree([folder('f1', null, 'Ops')], [note('c', 'f1', 'c'), ...sibs]), {}, true);
    const lg = localGraph(g, 'c')!;
    expect(lg.siblings).toHaveLength(LOCAL_CAP);
    expect(lg.siblingsMore).toBe(3);
    expect(lg.siblings[0].id).toBe('s14');
    expect(lg.parent).toEqual({ kind: 'folder', folder: expect.objectContaining({ id: 'f1', name: 'Ops' }) });
  });

  it('lists a two-way link once, as outgoing, and takes linked notes out of the siblings', () => {
    const t = tree([folder('f1', null)], [note('c', 'f1', 'c'), note('x', null, 'x'), note('s', 'f1', 's'), note('i', null, 'i')]);
    const g = buildVaultGraph('v1', t, { c: '[[x]] [[s]]', x: '[[c]]', i: '[[c]]' }, true);
    const lg = localGraph(g, 'c')!;
    expect(lg.outgoing.map((n) => n.id).sort()).toEqual(['s', 'x']);
    expect(lg.incoming.map((n) => n.id)).toEqual(['i']);
    expect(lg.siblings).toEqual([]);
  });

  it('uses the hub as parent for a root note and returns null for an unknown note', () => {
    const g = buildVaultGraph('v1', tree([], [note('c', null)]), {}, true);
    expect(localGraph(g, 'c')!.parent).toEqual({ kind: 'hub' });
    expect(localGraph(g, 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing tests `web/src/map/LocalMap.test.tsx`**

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph, type VaultGraph } from './graph';
import { LocalMap } from './LocalMap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function render(graph: VaultGraph, noteId = 'c') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LocalMap graph={graph} noteId={noteId} vaultName="Work" vaultColor="#9d7cf2" level={0.5} />} />
          <Route path="/v/:v/n/:n" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const graph = (ready = true) =>
  buildVaultGraph(
    'v1',
    tree([folder('f1', null, 'Ops')], [note('c', 'f1', 'c'), note('s1', 'f1', 's1'), note('s2', 'f1', 's2'), note('o1', null, 'o1'), note('i1', null, 'i1')]),
    { c: '[[o1]]', i1: '[[c]]' },
    ready,
  );
const row = (id: string) => host!.querySelector<SVGGElement>(`g.cmap-node[data-note="${id}"]`);

describe('LocalMap', () => {
  it('puts links in, siblings and links out in three columns', () => {
    render(graph());
    expect(row('i1')?.dataset.kind).toBe('incoming');
    expect(row('i1')?.getAttribute('transform')).toMatch(/^translate\(12 /);
    expect(row('s1')?.getAttribute('transform')).toMatch(/^translate\(117 /);
    expect(row('o1')?.getAttribute('transform')).toMatch(/^translate\(222 /);
    expect(row('c')).toBeNull();
    expect(host!.textContent).toContain('Ops');
  });

  it('clicking a neighbour opens it', () => {
    render(graph());
    act(() => void row('o1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host!.querySelector('[data-testid="where"]')?.textContent).toBe('/v/v1/n/o1');
  });

  it('caps a column and says how many more there are', () => {
    const sibs = Array.from({ length: 15 }, (_, i) => note(`s${i}`, 'f1', `s${i}`));
    render(buildVaultGraph('v1', tree([folder('f1', null)], [note('c', 'f1', 'c'), ...sibs]), {}, true));
    expect(host!.querySelectorAll('g.cmap-node[data-kind="siblings"]')).toHaveLength(12);
    expect(host!.querySelector('.lmap-more')?.textContent).toBe('+3 more');
  });

  it('says when links are still being drawn, and when there are no neighbours', () => {
    render(graph(false));
    expect(host!.querySelector('.lmap-msg')?.textContent).toBe('Drawing links…');
    act(() => root?.unmount());
    host?.remove();
    render(buildVaultGraph('v1', tree([], [note('c', null)]), {}, true));
    expect(host!.querySelector('.lmap-msg')?.textContent).toBe('No neighbours yet');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w web -- src/map/localGraph.test.ts src/map/LocalMap.test.tsx`
Expected: FAIL. The modules cannot be resolved.

- [ ] **Step 4: Implement `web/src/map/localGraph.ts`**

```ts
import type { GraphFolder, GraphNote, VaultGraph } from './graph';

export const LOCAL_CAP = 12;

export interface LocalGraph {
  center: GraphNote;
  parent: { kind: 'folder'; folder: GraphFolder } | { kind: 'hub' };
  siblings: GraphNote[];
  siblingsMore: number;
  outgoing: GraphNote[];
  outgoingMore: number;
  incoming: GraphNote[];
  incomingMore: number;
}

const recent = (a: GraphNote, b: GraphNote) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title);

function capped(list: GraphNote[]): [GraphNote[], number] {
  const sorted = [...list].sort(recent);
  return [sorted.slice(0, LOCAL_CAP), Math.max(0, sorted.length - LOCAL_CAP)];
}

/** One hop around a note: its folder, folder siblings, and notes it links to or from. */
export function localGraph(graph: VaultGraph, noteId: string): LocalGraph | null {
  const byId = new Map(graph.notes.map((n) => [n.id, n]));
  const center = byId.get(noteId);
  if (!center) return null;
  const folder = center.folderId ? graph.folders.find((f) => f.id === center.folderId) : undefined;

  const outIds = new Set<string>();
  const inIds = new Set<string>();
  for (const l of graph.links) {
    if (l.from === noteId) outIds.add(l.to);
    else if (l.to === noteId) inIds.add(l.from);
  }
  for (const id of outIds) inIds.delete(id);
  const pick = (ids: Set<string>) => [...ids].map((id) => byId.get(id)).filter((n): n is GraphNote => !!n);

  const [outgoing, outgoingMore] = capped(pick(outIds));
  const [incoming, incomingMore] = capped(pick(inIds));
  const [siblings, siblingsMore] = capped(
    graph.notes.filter((n) => n.id !== noteId && n.folderId === center.folderId && !outIds.has(n.id) && !inIds.has(n.id)),
  );
  return {
    center,
    parent: folder ? { kind: 'folder', folder } : { kind: 'hub' },
    siblings,
    siblingsMore,
    outgoing,
    outgoingMore,
    incoming,
    incomingMore,
  };
}
```

- [ ] **Step 5: Implement `web/src/map/LocalMap.tsx`**

```tsx
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { VaultIcon } from '../brand/VaultIcon';
import { relativeTime } from '../lib/util';
import type { GraphNote, VaultGraph } from './graph';
import { localGraph } from './localGraph';
import { inkTier } from './recency';
import { arrowDir, displayTitle, nearestInDirection } from './scene';

const W = 320;
const H = 250;
const PARENT = { x: 160, y: 18 };
const CENTER = { x: 160, y: 58 };
const COLS = { incoming: 12, siblings: 117, outgoing: 222 } as const;
const CAPTIONS = { incoming: 'links in', siblings: 'same folder', outgoing: 'links out' } as const;
const CAPTION_Y = 92;
const ROW0 = 106;
const ROW = 11.5;

type Kind = keyof typeof COLS;
interface Spot {
  note: GraphNote;
  kind: Kind;
  x: number;
  y: number;
}

export const clip = (s: string, n = 14) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function LocalMap({
  graph,
  noteId,
  vaultName,
  vaultColor,
  level,
  now = Date.now(),
}: {
  graph: VaultGraph;
  noteId: string;
  vaultName: string;
  vaultColor: string;
  level: number;
  now?: number;
}) {
  const navigate = useNavigate();
  const lg = useMemo(() => localGraph(graph, noteId), [graph, noteId]);
  const refs = useRef(new Map<string, SVGGElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  if (!lg) return null;

  const spots: Spot[] = [];
  const column = (kind: Kind, list: GraphNote[]) =>
    list.forEach((note, i) => spots.push({ note, kind, x: COLS[kind], y: ROW0 + i * ROW }));
  column('incoming', lg.incoming);
  column('siblings', lg.siblings);
  column('outgoing', lg.outgoing);
  const more: [Kind, number, number][] = [
    ['incoming', lg.incomingMore, lg.incoming.length],
    ['siblings', lg.siblingsMore, lg.siblings.length],
    ['outgoing', lg.outgoingMore, lg.outgoing.length],
  ];
  const rovingId = focusId && spots.some((s) => s.note.id === focusId) ? focusId : (spots[0]?.note.id ?? null);
  const open = (id: string) => navigate(`/v/${graph.vaultId}/n/${id}`);

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const dir = arrowDir(e.key);
    const from = spots.find((s) => s.note.id === rovingId);
    if (!dir || !from) return;
    e.preventDefault();
    const next = nearestInDirection(
      from,
      spots.map((s) => ({ id: s.note.id, x: s.x, y: s.y })),
      dir,
    );
    if (next) {
      setFocusId(next);
      refs.current.get(next)?.focus();
    }
  };

  const hub = lg.parent.kind === 'hub';
  const parentName = lg.parent.kind === 'folder' ? lg.parent.folder.name : vaultName;
  const centerTitle = displayTitle(lg.center.title);

  return (
    <div className="lmap">
      <svg viewBox={`0 0 ${W} ${H}`} className="lmap-svg" role="group" aria-label={`Notes near ${centerTitle}`} onKeyDown={onKeyDown}>
        <g className="cmap-pencil">
          <line x1={PARENT.x} y1={PARENT.y} x2={CENTER.x} y2={CENTER.y} />
          {spots
            .filter((s) => s.kind === 'siblings')
            .map((s) => (
              <line key={s.note.id} x1={PARENT.x} y1={PARENT.y} x2={s.x} y2={s.y} />
            ))}
        </g>
        <g className="cmap-links">
          {spots
            .filter((s) => s.kind !== 'siblings')
            .map((s) => (
              <line key={s.note.id} x1={CENTER.x} y1={CENTER.y} x2={s.x} y2={s.y} />
            ))}
        </g>
        <g transform={`translate(${PARENT.x} ${PARENT.y})`}>
          {hub && (
            <g transform="translate(-7 -7)">
              <VaultIcon color={vaultColor} level={level} size={14} />
            </g>
          )}
          <text className="lmap-parent-name" x={hub ? 10 : 0} y={4} textAnchor={hub ? 'start' : 'middle'}>
            {clip(parentName, 24)}
          </text>
        </g>
        <g transform={`translate(${CENTER.x} ${CENTER.y})`}>
          <circle className={`cmap-dot tier-${inkTier(lg.center.updatedAt, now)}`} r={4.5} />
          <circle className="lmap-ring" r={8} />
          <text className="cmap-label" x={12} y={3.5}>
            {clip(centerTitle, 24)}
          </text>
        </g>
        {(Object.keys(COLS) as Kind[])
          .filter((k) => spots.some((s) => s.kind === k))
          .map((k) => (
            <text key={k} className="lmap-caption" x={COLS[k]} y={CAPTION_Y}>
              {CAPTIONS[k]}
            </text>
          ))}
        {spots.map((s) => {
          const title = displayTitle(s.note.title);
          return (
            <g
              key={s.note.id}
              ref={(el) => {
                if (el) refs.current.set(s.note.id, el);
                else refs.current.delete(s.note.id);
              }}
              className="cmap-node"
              data-note={s.note.id}
              data-kind={s.kind}
              transform={`translate(${s.x} ${s.y})`}
              role="link"
              tabIndex={s.note.id === rovingId ? 0 : -1}
              aria-label={`${title}, ${CAPTIONS[s.kind]}, edited ${relativeTime(s.note.updatedAt, now)}`}
              onClick={() => open(s.note.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(s.note.id);
                }
              }}
              onFocus={() => setFocusId(s.note.id)}
            >
              <title>{title}</title>
              <rect className="cmap-hit" x={-6} y={-ROW / 2} width={100} height={ROW} />
              <circle className={`cmap-dot tier-${inkTier(s.note.updatedAt, now)}`} r={3} />
              <text className="lmap-label" x={7} y={3.2}>
                {clip(title)}
              </text>
            </g>
          );
        })}
        {more
          .filter(([, n]) => n > 0)
          .map(([kind, n, len]) => (
            <text key={kind} className="lmap-more" x={COLS[kind]} y={ROW0 + len * ROW + 3}>
              +{n} more
            </text>
          ))}
      </svg>
      {!graph.linksReady ? <p className="lmap-msg">Drawing links…</p> : spots.length === 0 ? <p className="lmap-msg">No neighbours yet</p> : null}
    </div>
  );
}
```

- [ ] **Step 6: Append the local map styles to `web/src/styles/map.css`**

```css
/* Local map (note page) */
.lmap {
  position: relative;
  aspect-ratio: 100 / 78;
  background: var(--canvas);
  border: 1px solid var(--side-border);
  border-radius: 8px;
  overflow: hidden;
}
.lmap-svg {
  display: block;
  width: 100%;
  height: 100%;
}
.lmap-svg .cmap-dot {
  stroke-width: 3;
}
.lmap-label {
  font: 500 9.5px var(--font-ui);
  fill: var(--muted);
  pointer-events: none;
}
.cmap-node:hover .lmap-label,
.cmap-node:focus-visible .lmap-label {
  fill: var(--text);
}
.lmap-parent-name {
  font: italic 500 11px var(--font-serif);
  fill: var(--text);
}
.lmap-caption {
  font: 500 8.5px var(--font-ui);
  fill: var(--muted-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.lmap-more {
  font: 500 9px var(--font-ui);
  fill: var(--muted-3);
}
.lmap-ring {
  fill: none;
  stroke: var(--map-ink);
  stroke-width: 1.5;
}
.lmap-msg {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 6px;
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: var(--muted-3);
  pointer-events: none;
}
```

- [ ] **Step 7: Add the Local map section to `web/src/pages/NotePane.tsx`**

Add `import { LocalMap } from '../map/LocalMap';`. Add `vaultStats` to the existing `StoreContext` import (`import { folderPath, titleIndex, useAppState, useStore, vaultStats } from '../state/StoreContext';`). Inside `<aside className="ctx" aria-label="Note context">`, before the Backlinks `<section>`, insert:

```tsx
        {graph && head && (
          <section className="ctx-section">
            <h2 className="ctx-title">Local map</h2>
            <LocalMap graph={graph} noteId={noteId} vaultName={vault.name} vaultColor={vault.color} level={vaultStats(vault, tree).level} />
          </section>
        )}
```

(`graph` is the `useVaultGraph(state, vault.id)` const added in Task 5.)

- [ ] **Step 8: Run the tests, the full suite and the build**

Run: `npm test -w web -- src/map/localGraph.test.ts src/map/LocalMap.test.tsx`
Expected: PASS (7 tests).
Run: `npm test -w web`, `npm test -w server`, then `npm run build -w web`
Expected: all pass; the build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/src/map/localGraph.ts web/src/map/localGraph.test.ts web/src/map/LocalMap.tsx web/src/map/LocalMap.test.tsx web/src/styles/map.css web/src/pages/NotePane.tsx
git commit -m "feat(map): 1-hop local map on the note page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
