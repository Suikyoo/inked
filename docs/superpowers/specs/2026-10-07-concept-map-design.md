# Concept map (round 2) — design

Date: 2026-10-07. Status: approved in conversation (sections 1–3). Base spec: `docs/architecture.md`. Visual reference: the approved design canvas `Main.dc.html` (home map) and `Note.dc.html` (local map), using the "pencil & ink + wet/dry" direction.

## Intent

Replace the Home placeholder ("Concept map arrives in the next build") with a concept map of every vault. Add a small local map to the note page. Connections come from the folder hierarchy first, and `[[links]]` are drawn on top. The map is a way to see where a note lives and what is fresh. It is not a second editor.

Success means:
- Home shows every vault as a hub. Folders sit on rings around the hub and notes sit around their folders.
- The map pans and zooms, fits on load, and stays usable at 200 notes per vault.
- Search on Home inks the matching notes on the map.
- The note page shows a 1-hop local map above Backlinks.
- Nothing about the map reaches the server or browser storage.
- The full test suite and the build pass.

What the owner said:
- Use the approved design: pencil & ink plus wet/dry recency, the vault drop icon with its ink level, and a local map on the note page.
- Scale: under about 200 notes in the largest vault.
- The Home map supports pan and zoom.
- The local map shows 1 hop.
- Use approach A: a deterministic ring layout, rendered as React SVG, with hand-written pan and zoom and no new dependencies.

Assumptions (not objected to):
- Search on Home drives the ink highlighting.
- Backlinks start counting root-relative note links as well as `[[wiki-links]]`.

## Already in place

- `web/src/brand/VaultIcon.tsx`: the drop icon with its ink level, and `vaultStats` in `web/src/state/StoreContext.tsx`.
- `wikiLinkTargets(src)` in `web/src/markdown/plugins.ts`, and `titleIndex(tree)` and `folderPath(tree, folderId)` in `StoreContext.tsx`.
- `AppState.trees`, `AppState.bodies` and `AppState.bodiesReady` hold the decrypted tree and note bodies in memory after unlock.
- The `HomePage` search (`searchTitles`, `searchBodies`) and the note page's `aside.ctx` with its Backlinks section.

## Section 1 — Data and layout (`web/src/map/`, pure functions)

These files import neither React nor the store. Each one gets its own unit tests.

### `graph.ts`

```ts
export interface GraphFolder { id: string; parentId: string | null; name: string; depth: number }
export interface GraphNote { id: string; folderId: string | null; title: string; updatedAt: string }
export interface GraphLink { from: string; to: string }
export interface VaultGraph {
  vaultId: string;
  folders: GraphFolder[];
  notes: GraphNote[];
  links: GraphLink[];
  linksReady: boolean;
}
export function buildVaultGraph(vaultId: string, tree: TreeView, bodies: Record<string, string>, bodiesReady: boolean): VaultGraph;
export function noteLinkTargets(src: string, vaultId: string, titles: Map<string, string>): Set<string>;
```

- Folders and notes flagged `broken` are left out. A note whose folder is broken or missing is placed at the root.
- `depth` is 0 for a top-level folder.
- `noteLinkTargets` returns note ids from two sources:
  - `[[wiki-links]]`, resolved through `titleIndex`;
  - Markdown links whose target is root-relative and matches `^/v/{vaultId}/n/{noteId}`, with an optional `#…` or `?…` suffix.
- The function drops self-links, links to a note that is not in the graph, and links into another vault.
- `links` are directed and deduplicated by `(from, to)`.
- `linksReady` mirrors `bodiesReady[vaultId]`.

### `layout.ts`

```ts
export interface Pt { x: number; y: number }
export interface VaultLayout {
  vaultId: string;
  radius: number;
  folders: Record<string, Pt>;
  notes: Record<string, Pt>;
  parent: Record<string, string | null>;
}
export function layoutVault(graph: VaultGraph): VaultLayout;
export function layoutWorld(layouts: VaultLayout[], gap?: number): Record<string, Pt>;
```

- **Coordinates.** `layoutVault` works in vault-local units with the hub at (0,0). `parent` maps every folder id and note id to its parent folder id, or to `null` for the hub. Pencil lines and ink paths are drawn from `parent`.
- **Slices.** The full circle is split among the top-level entries: each top-level folder, plus one "root notes" slice if any note has no folder. A slice's angle is proportional to its weight. The weight is `1 + the weight of each child folder`, so it counts folders only. Notes are left out so that adding a note never resizes another folder's slice (see Stability).
- **Folder rings.** A top-level folder sits at radius `R0`, at the angular centre of its slice. Child folders split the parent's slice by weight in the same way. They sit at `max(r + RSTEP, outermost note row of the parent + NR)`, which depends only on the parent's own notes.
- **Note rows.** A folder's own notes sit in the folder's slice, in hub-centred rows at radius `r + NR + k·NSTEP` (k = 0, 1, …), spread evenly across the slice. A row holds as many notes as fit with a chord of at least `MIN_GAP` between neighbours. Any notes left over wrap to the next row out.
- **Root notes.** They sit in their own slice using the same rows, starting at radius `R0`.
- **Order.** Siblings are sorted by `name.localeCompare` (folders) or `title.localeCompare` (notes), with the id as tie-break. Nothing is random.
- **Radius.** `radius` is the distance from the hub to the farthest dot, plus the label margin.
- **Constants.** `R0`, `RSTEP`, `NR`, `NSTEP` and `MIN_GAP` are exported constants. The plan chooses their values. They must keep dots in one arc at least `MIN_GAP` apart.
- **World layout.** `layoutWorld` places the vault circles in rows, in the given (sidebar) order, with the row width capped at about the square root of the total area. It returns each vault's world-space centre.
- **Stability.** Links and edit times never affect positions. Adding, removing or renaming a note moves only dots in that note's folder and that folder's descendant folders. Adding or removing a folder rebalances the slices.

### `recency.ts`

```ts
export type InkTier = 'wet' | 'fresh' | 'drying' | 'dry';
export function inkTier(updatedAt: string, now: number): InkTier;
```

| Age | Tier | Dot colour | Glow |
|---|---|---|---|
| under 24 h | wet | `#B69CFF` | `0 0 9px 3px rgba(182,156,255,.38)` |
| under 7 d | fresh | `#9D7CF2` | `0 0 4px 1px rgba(157,124,242,.22)` |
| under 30 d | drying | `#6B5A9E` | none |
| 30 d or more | dry | `#524B6E` | none |

- This is an ordinal ramp: one hue with lightness falling step by step. It was checked with the dataviz validator (`--ordinal --mode dark --surface #1A1920`), and every check passed. The dry end, `#524B6E`, has 2.15:1 contrast against the canvas. The earlier `#3F3A52` had 1.61:1, below the 2:1 floor.
- Boundaries are exclusive at the upper end: exactly 24 h is `fresh`.
- A timestamp that won't parse, or lies in the future, counts as `wet`.
- In SVG the glow is drawn as an SVG `filter` (blur), with the same visual intent. CSS `box-shadow` does not apply to SVG.
- Colours become CSS custom properties: `--ink-wet`, `--ink-fresh`, `--ink-drying`, `--ink-dry`, `--map-pencil: #4A4659`, `--map-ink: #9D7CF2`.

### Data flow

- `map/useVaultGraphs.ts` is a hook. It returns `{ graph, layout }` per non-broken vault in `vaultOrder`.
- The graph is memoised on `(tree, bodies-for-that-vault, bodiesReady)`. The layout is memoised on the graph's folders and notes only, so decryption progress never re-runs the layout.
- No store, server, API or crypto change. Map data lives only in React memory.

## Section 2 — Home map

### Components

- `map/ConceptMap.tsx`: the SVG map.
  - Props: `entries` (`{ graph, layout }[]`), `hits: Set<string>` (note ids), `hot: string | null` (the result being hovered or focused), `vaults` (for name, colour and ink level).
  - It uses `useNavigate` to open notes.
- `map/useViewport.ts`: the pan and zoom state.
  - The state is `{ scale, tx, ty }`.
  - Pure helpers: `zoomAt(view, factor, px, py)` keeps the world point under `(px, py)` fixed, `fit(bounds, size, padding)`, and `clampScale`. Scale is limited to 0.4–4.
- `map/MapSlip.tsx`: the card for the selected note. It shows the title, the folder path, "edited {relativeTime} · {n} links", and a `Link` reading "Open note →".
- `HomePage.tsx` replaces `section.map-placeholder` with `<ConceptMap>`. It passes the ids from `titleHits` and `bodyHits` as `hits`, and the hovered or focused result as `hot`.
- The legend sits below the map and follows the design:
  - "pencil: folder lines at rest";
  - "ink: your search and open note";
  - the wet → dry dots;
  - "[[links]]".

### Rendering

- Screen coordinates are computed in JavaScript as `world·scale + t`. The SVG `viewBox` matches the element's pixel size. Dots, strokes and text therefore stay the same size at every zoom level.
- The element's size comes from a `ResizeObserver`, with a fallback of 800×480 (also the size under jsdom).
- Layers, back to front:
  1. Pencil lines: `parent` → child, 1 px, `--map-pencil`.
  2. Link lines: 1 px dashed (`3 3`), `--map-pencil`. Drawn only when `linksReady`.
  3. Ink: one tapered filled path per inked note, following the hub → folder chain → note, in `--map-ink`. The polygon is wider at the hub end and narrower at the note end.
  4. Dots: radius 4 px (8 px marker), or 5 px when selected, hot or hovered. Filled with the tier colour, with a 2 px ring in the canvas colour. Each dot has a transparent hit circle of radius 12 px (24 px target).
  5. Folder labels: Public Sans 10.5 px on a canvas-coloured pill.
  6. Hubs: the `VaultIcon` plus the vault name in Spectral italic.
- **Note labels** show when `scale ≥ 1.6`, or when the note is hovered, focused, selected, hot or a hit.
- **Hover and focus label.** A hovered or focused dot shows `{title} · {relativeTime}` as its label, so hover and keyboard focus show the same details. Labels use text tokens, never the tier colour.
- **Search fading.** When `hits` is non-empty, notes that are not hits drop to 30 % opacity.
- **Ink** is drawn for every hit, which search already caps at 30 title hits plus 15 body hits, plus the selected note and the `hot` note.

### Interaction

- **Wheel:** zooms by `1.0015^(−deltaY)` around the pointer, with `preventDefault` so the page doesn't scroll.
- **Pinch:** two active pointers zoom around their midpoint.
- **Drag:** a pointer drag of 4 px or more pans the map, using pointer capture. Anything under 4 px is a click.
- **Buttons** at top right: zoom in (×1.25), zoom out (÷1.25), and fit. Each is an icon button with an `aria-label`.
- **On mount:** the map fits all vaults with 24 px padding. It fits again when the vault set changes. It doesn't re-fit when only notes change.
- **Dots:**
  - Clicking a dot selects it and opens the slip, placed near the dot and kept inside the frame.
  - Clicking empty space or pressing Escape clears the selection.
  - Enter or Space on a focused dot opens the note.
- **Hubs:** clicking a hub fits the view to that vault.
- **Motion:** animated fits run for 200 ms. With `prefers-reduced-motion: reduce` they jump instead.

### Accessibility

- The SVG has `role="group"` and `aria-label="Concept map of all vaults"`, with a description listing the keys.
- **One Tab stop.** Dots use a roving `tabindex`. The first dot is the selected note, else the first hit, else the most recently edited note.
- **Dots** are `<g role="button" aria-label="{title}, {folder path or 'vault root'}, edited {relativeTime}">` with a visible focus ring.
- **Keys:**
  - Arrow keys move focus to the nearest dot within a 90° cone in that direction, measured in screen space.
  - `+` or `=` zooms in, `-` zooms out, and `0` fits.
  - Focusing a dot that is outside the view pans it into view.
- The results list stays the full text alternative.

### States

- While `vaultsStatus !== 'ready'`, or any tree is still loading and nothing is drawn yet, the frame shows "Decrypting your notes…".
- With no vaults, the map section isn't rendered, and the existing empty message in the results column stays.
- An empty vault shows its hub only.
- A vault whose tree has `status: 'error'` shows its hub with the caption "Couldn't load".
- While any `linksReady` is false, the legend adds "Links appear once note text is decrypted."
- Viewport and selection are component state. They are not stored anywhere and are reset on lock, because the component unmounts.

### Styles

- `web/src/styles/map.css` takes over the frame from `.map-placeholder`: canvas background, 1 px `--side-border`, 10 px radius, `aspect-ratio: 100 / 60`, `min-height: 320px`.
- The map is `touch-action: none` and `cursor: grab`, switching to `grabbing` while dragging.
- Use classes for static styling. Use SVG presentation attributes (`x`, `fill` and so on) for geometry. React `style` props are fine for dynamic values such as the slip position; React applies them through the CSSOM, which `style-src 'self'` allows, and `Menu.tsx` already does this. Never inject `<style>` elements or set a `style` attribute string.

## Section 3 — Local map, backlinks, errors, tests

### `map/localGraph.ts`

```ts
export interface LocalGraph {
  center: GraphNote;
  parent: { kind: 'folder'; folder: GraphFolder } | { kind: 'hub' };
  siblings: GraphNote[]; siblingsMore: number;
  outgoing: GraphNote[]; outgoingMore: number;
  incoming: GraphNote[]; incomingMore: number;
}
export const LOCAL_CAP = 12;
export function localGraph(graph: VaultGraph, noteId: string): LocalGraph | null;
```

- `siblings` are the other notes in the same folder (or at the root). A note that also appears in `outgoing` or `incoming` is listed only in the link group.
- `outgoing` and `incoming` come from `graph.links`. A note that links both ways appears once, in `outgoing`.
- Each group is sorted by `updatedAt` descending, then title. It is capped at `LOCAL_CAP`, and `…More` holds the remainder.
- The function returns `null` when the note isn't in the graph.

### `map/LocalMap.tsx`

- It is a section at the top of `aside.ctx`, titled "Local map", above Backlinks.
- It uses a fixed frame (`aspect-ratio: 100 / 78`) and the same SVG approach as the Home map, with no pan or zoom.
- **Placement** (in a 320×250 viewBox). Twelve always-labelled notes per group don't fit on arcs in a side panel, so each group gets a column:
  - the parent (folder label, or the vault drop icon plus the vault name) sits at the top centre;
  - the centre note sits below it, with a 1.5 px ring in `--map-ink`;
  - underneath are three captioned columns: "links in" on the left, "same folder" in the middle and "links out" on the right;
  - each column is a vertical list of dots with their labels to the right. Each row's hit area is a transparent rectangle covering the dot and its label;
  - pencil lines join the parent to the centre and to each sibling, and dashed lines join the centre to each linked note;
  - a "+N more" label ends any column that was capped.
- Labels are always visible, cut to 14 characters with "…". The full title is in the `aria-label` and the SVG `<title>`.
- Clicking a dot, or pressing Enter or Space, navigates to `/v/{vaultId}/n/{id}`.
- Keyboard behaviour is the same roving tabindex and arrow-key model as the Home map.
- **States:**
  - "Drawing links…" while `!linksReady`; siblings are still drawn;
  - "No neighbours yet" when every group is empty.

### Backlinks from the graph

- `NotePane` takes its backlinks from `incoming` in the vault graph, uncapped, and drops its own `wikiLinkTargets` scan. Backlinks and the map then always agree.
- Backlinks now include root-relative Markdown links to the note.
- `docs/architecture.md` is updated to say so.

### Error handling

- A tree that failed to load gets a hub with the caption "Couldn't load" and no dots.
- Broken notes and folders are left out, as set in section 1.
- The map has no network calls, so there are no new failure modes beyond the existing loading states.
- Lock, sign-out and session end already clear `trees` and `bodies`. The map renders from them and holds no copy.

### Tests (vitest)

- **`graph.test.ts`:**
  - wiki-link resolution is case-insensitive;
  - root-relative links resolve, with and without `#`;
  - links to another vault are dropped;
  - self-links are dropped;
  - duplicates are merged;
  - broken notes and folders are excluded;
  - a note in a broken folder goes to the root;
  - `linksReady` follows `bodiesReady`.
- **`layout.test.ts`:**
  - the same input gives deep-equal output;
  - adding a note to folder A moves no dot in folder B;
  - root notes are placed;
  - nesting four levels deep works;
  - all dot pairs in one row are at least `MIN_GAP` apart;
  - `layoutWorld` produces no overlapping vault circles;
  - 1,000 notes across 40 folders lay out in under 50 ms.
- **`recency.test.ts`:**
  - the tier at exactly 24 h, 7 d and 30 d, and just under each;
  - an invalid timestamp and a future timestamp give `wet`.
- **`useViewport.test.ts`:**
  - after `zoomAt`, the world point under the cursor stays fixed;
  - scale is clamped at 0.4 and 4;
  - `fit` centres the bounds.
- **`localGraph.test.ts`:**
  - the caps and the `…More` counts;
  - the two-way link dedupe;
  - siblings that are also links are removed;
  - the root note's parent is the hub;
  - `null` for an unknown id.
- **`ConceptMap.test.tsx`:**
  - the number of dots equals the number of non-broken notes;
  - clicking a dot shows the slip with the title;
  - Enter on a dot navigates;
  - `hits` fades the non-hits;
  - ArrowRight moves focus to the dot on the right;
  - Escape clears the selection;
  - the empty vault and the error hub render.
- **`LocalMap.test.tsx`:**
  - the three columns render;
  - clicking a dot navigates;
  - the "+N more" label;
  - the "Drawing links…" state.
- **`NotePane` test:** backlinks include a note that links via `/v/{vaultId}/n/{id}`.

## Out of scope

- A map on the vault page.
- Lines between vaults.
- Dragging or pinning dots, or saving positions.
- Tag-based edges.
- Any server, API or crypto change.
- `DESIGN.md` and canvas cleanup.

## Constraints carried from the base spec

- The server never receives plaintext or decrypting keys. The map adds no request.
- Only `inked.lastUsername` and `inked.spellcheck` may be written to localStorage. The map writes nothing.
- CSP stays `style-src 'self'`. Do not inject `<style>` elements or set `style` attribute strings. React `style` props are allowed.
- No new runtime dependencies.
