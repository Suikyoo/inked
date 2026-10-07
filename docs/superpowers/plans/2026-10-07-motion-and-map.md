# Round 3: Motion, Map Rendering, Index Notes and Preview Panel (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Add quiet motion with ink accents across Inked.
- Re-render the concept map with quill curves and square folder nodes.
- Give every folder an `Index` note.
- Replace Home's "Recently edited" column with a node preview panel.

**Architecture:**
- **Motion:** CSS tokens plus three small helpers in `web/src/motion/` (`usePresence`, reduced-motion hooks, `withViewTransition`). Components opt in with `data-state` attributes and stylesheet rules.
- **Map:** the pure geometry in `scene.ts` swaps tapered polygons for quadratic curve paths. `ConceptMap` gains folder nodes and a selection callback; its in-map slip is removed.
- **Index notes:** a client-side convention (a note titled `Index`) found by a pure helper.
- **Home:** the right column becomes a three-state panel: search results, node preview, or empty.

**Tech Stack:** React 18, react-router-dom 7, TypeScript 5.9, vitest + jsdom (no testing-library; tests use `act` + `createRoot`), plain CSS.

**Spec:** `docs/superpowers/specs/2026-10-07-motion-and-map-design.md` (Sections 1–4, the map legend removal, Testing). Visual reference: design canvas artboard "Map — CHOSEN" (`MapP5.dc.html`). Each task's brief names the spec sections it implements. Read them; they are the authority for exact values.

## Global Constraints

- No new dependencies. No server, API or crypto change.
- CSP stays `style-src 'self'`.
  - Never inject `<style>` and never set a `style` attribute string.
  - React `style` props are fine, and so are CSS custom properties set via `element.style.setProperty`.
  - View Transition pseudo-elements are styled only from stylesheets.
- Animate only `opacity`, `transform`, `clip-path`, SVG `stroke-dashoffset`, and `grid-template-rows` for collapse.
- No bounce or overshoot. No looping animation except the spinner. Animations never block input.
- Motion tokens, exact values, in `web/src/styles/tokens.css`:
  - `--dur-1: 90ms`, `--dur-2: 140ms`, `--dur-3: 200ms`, `--dur-4: 320ms`, `--dur-ink: 520ms`
  - `--ease-in: cubic-bezier(0.4, 0, 1, 1)`, `--ease-std: cubic-bezier(0.2, 0, 0, 1)`
  - The existing `--ease-out` stays.
- Reduced motion:
  - transforms, wipes, ink draws and write-on are disabled;
  - opacity transitions stay, at 120ms or less;
  - final states render immediately;
  - there are no view transitions;
  - the spinner pulses instead of rotating.
- Copy, exact:
  - "Select a folder or note on the map."
  - "Add description"
  - "Decrypting…"
  - "Links appear once note text is decrypted."
  - "Open note", "Edit", "Open Index", "New note here", "Zoom to folder"
- The Index note title is exactly `Index`, case-sensitive. Its default body is `# {folder name}\n\nDescribe what lives in this folder.\n`.
- Nothing is written to localStorage. The "first paint this session" flag is an in-memory module variable.
- Commands, run from the repo root `C:\Users\User\Desktop\stuff\notes`: `npm test -w web`, `npm run build -w web`, `npm test -w server`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A deleted or renamed Index.** The folder must fall back to "Add description" with no crash. Two notes titled `Index` resolve to the oldest. Pinned in Task 4.
2. **A selection that disappears.** If the selected node is deleted or its vault is locked, the preview panel returns to the empty state and does not show stale plaintext. Pinned in Task 7.
3. **Expand-opens-Index must not hijack.** Expanding a folder while viewing a note inside it must not navigate away. Pinned in Task 5.
4. **Exit animations under rapid toggling.** Opening and closing a menu or dialog quickly must never leave an invisible mounted element that eats clicks. Pinned in Tasks 1 and 2.
5. **The ink write-on replays only once per session.** Navigating Home → note → Home must not redraw the whole map. Pinned in Task 6.

---

### Task 1: Motion foundation

**Spec:** Section 1 (tokens, helpers, reduced motion), plus the spinner rule from Section 2.

**Files:**
- Create: `web/src/motion/presence.ts`, `web/src/motion/reducedMotion.ts`, `web/src/motion/viewTransition.ts`, `web/src/motion/index.ts` (re-exports)
- Test: `web/src/motion/presence.test.tsx`, `web/src/motion/reducedMotion.test.ts`, `web/src/motion/viewTransition.test.ts`
- Modify: `web/src/styles/tokens.css` (motion tokens), `web/src/styles/base.css` (replace the blanket reduced-motion rule; spinner at 1.2s with a reduced-motion pulse), and every stylesheet with hard-coded `120ms`/`200ms` transitions (switch them to the tokens)

**Interfaces (produces):**
- `usePresence(open: boolean, exitMs: number): { mounted: boolean; state: 'enter' | 'open' | 'exit'; ref: (el: HTMLElement | SVGElement | null) => void }`. Attach `ref` to the animated root.
- `prefersReducedMotion(): boolean`. A missing `matchMedia` counts as reduced.
- `useReducedMotion(): boolean`. Updates on the media query's `change` event.
- `withViewTransition(update: () => void): void`.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - `presence.test.tsx` (jsdom, fake timers, a tiny host component rendering `<div ref={p.ref} data-state={p.state}>` while `p.mounted`):
    - open=true gives `mounted` and `enter`, then `open` on the next frame or tick;
    - open=false gives `exit`, and the element unmounts on `animationend` dispatched on it;
    - without `animationend`, it unmounts after `exitMs + 50`;
    - open=true during an exit cancels it: it stays mounted and ends `open`;
    - rapid true/false/true/false leaves it unmounted after the timeout (Review Focus 4).
  - `reducedMotion.test.ts`: mocked `matchMedia` returns true or false; missing `matchMedia` gives true; the hook updates on a dispatched `change`.
  - `viewTransition.test.ts`:
    - with no `document.startViewTransition`, `update` is called synchronously;
    - with it present and reduced motion off, it is called with `update`;
    - with reduced motion on, `update` is called directly.
- [ ] **Step 2:** run `npm test -w web -- src/motion`. Expected: FAIL (the modules don't exist).
- [ ] **Step 3: implement.**
  - `usePresence`:
    - keep `state` in `useState`;
    - on open, mount with `enter`, then `requestAnimationFrame` (or `setTimeout(…, 0)` when rAF is missing) to `open`;
    - on close, set `exit`, listen once for `animationend`/`transitionend` on the ref'd element, and also start the timeout; whichever fires first unmounts;
    - clear the listeners and timers on re-open and on unmount.
  - The others are direct translations of the spec text.
- [ ] **Step 4: CSS.**
  - Add the tokens.
  - Replace the blanket reduced-motion rule in base.css with targeted rules:
    - `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-property: opacity, color, background-color, border-color !important; transition-duration: 120ms !important; } }`
    - plus the spinner pulse rule.
  - Spinner: `animation: spin 1.2s linear infinite`. Under reduced motion: `animation: pulse 1.6s ease-in-out infinite` (opacity .45↔1, the one allowed loop).
  - Replace the hard-coded durations with tokens.
- [ ] **Step 5:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 6:** commit `feat(motion): tokens, usePresence, reduced-motion hooks, view-transition helper; calmer spinner`.

---

### Task 2: Overlays (dialogs, menus, banners, sync bar)

**Spec:** Section 2, the dialogs, menus and banners/sync bar bullets.

**Files:**
- Modify: `web/src/styles/base.css` (or wherever `.dialog` and menu styles live), `web/src/components/Menu.tsx`, `web/src/components/AppShell.tsx` (banner and sync bar)
- Test: `web/src/components/Menu.test.tsx` (new), `web/src/components/AppShell.test.tsx` (new, or extend an existing test if present)

**Interfaces:** consumes `usePresence` from Task 1.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - Menu: after closing, the menu element stays in the DOM with `data-state="exit"` until `animationend`, then is removed. Clicking the trigger again during the exit reopens it (`data-state` becomes `open`). After rapid open/close, no `[role=menu]` remains after the timeout (Review Focus 4).
  - AppShell banner: when `state.notice` clears, the banner gets `data-state="exit"`, then unmounts. The same for the sync bar when `pendingCount` drops to 0.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3: implement.**
  - **Dialog** (CSS only; the native `<dialog>` stays):
    ```css
    .dialog {
      opacity: 0;
      transform: scale(.98);
      transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in), display var(--dur-2) allow-discrete, overlay var(--dur-2) allow-discrete;
    }
    .dialog[open] {
      opacity: 1;
      transform: none;
      transition-duration: var(--dur-3);
      transition-timing-function: var(--ease-out);
    }
    @starting-style { .dialog[open] { opacity: 0; transform: scale(.98); } }
    ```
    The `::backdrop` gets the same fade.
  - **Menu:** `usePresence(open, 90)`.
    - Render while `mounted`, with `data-state`.
    - Enter is a keyframe on fade plus `scale(.97)`, with `transform-origin` from the anchor side (top or bottom, left or right, computed with the existing position).
    - Exit is a fade over `--dur-1`.
  - **Banner and sync bar:** wrap each in `<div class="collapse" data-state>`.
    - `.collapse` uses `display: grid; grid-template-rows: 1fr` with an inner `min-height: 0` element.
    - Enter: fade plus `translateY(-6px)` → 0.
    - Exit: opacity 0 and `grid-template-rows: 0fr` over `--dur-2`.
    - Keep the last notice text in a ref while exiting, so the content doesn't go blank mid-animation.
- [ ] **Step 4:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5:** commit `feat(motion): dialog, menu, banner and sync-bar enter/exit`.

---

### Task 3: Auth motion (drop-fill, unlock wipe, lock fade, error nudge)

**Spec:** Section 2, the unlock, lock, wrong-password and register/setup bullets.

**Files:**
- Create: `web/src/brand/InkFill.tsx` (the drop-fill indicator), `web/src/brand/InkFill.test.tsx`
- Modify:
  - `web/src/pages/LoginPage.tsx` (drop-fill in the unlock button; error nudge class; wipe origin);
  - `web/src/pages/RegisterFlow.tsx` and `web/src/pages/SetupPage.tsx` (drop-fill instead of the spinner while busy);
  - wherever unlock success triggers the app swap (the store's `unlock` resolving, which re-renders `App.tsx`; wrap the post-unlock state change in `withViewTransition`);
  - `web/src/styles/auth.css` (keyframes and `::view-transition-*` rules)
- Test: `web/src/brand/InkFill.test.tsx`, extend `web/src/App.test.tsx` or the LoginPage tests

**Interfaces:**
- Produces `InkFill({ done }: { done: boolean })`, a 14px drop SVG.
  - The fill rises toward 85% over 1.5s with `--ease-out`.
  - When `done` it goes to 100% over `--dur-2`.
  - Under reduced motion the drop is static, with a pulsing opacity.
- Produces `setWipeOrigin(x: number, y: number): void`. It sets `--wipe-x`/`--wipe-y` on `document.documentElement`.
- Consumes `withViewTransition` and `useReducedMotion` from Task 1.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - InkFill renders an `svg` with a mask or clip rect. With `done`, the clip `y` attribute is 0.
  - Login: a wrong password adds the class `nudge` to the password field wrapper, removed on `animationend`. A successful unlock calls the view-transition helper; mock `document.startViewTransition` and assert it was called with a function.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3: implement.**
  - CSS: `::view-transition-new(root) { animation: ink-wipe var(--dur-4) var(--ease-out) both; }`, where `@keyframes ink-wipe { from { clip-path: circle(0 at var(--wipe-x) var(--wipe-y)); } to { clip-path: circle(150% at var(--wipe-x) var(--wipe-y)); } }`.
  - Set `::view-transition-old(root) { animation: none; }`.
  - Lock and sign-out: the login card gets an enter fade of 200ms. Lock does not use the view transition.
  - Nudge: `@keyframes nudge { 0%, 100% { transform: none } 33% { transform: translateX(-3px) } 66% { transform: translateX(3px) } }`, 200ms, applied once.
  - The recovery-key panel fades in.
- [ ] **Step 4:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5:** commit `feat(motion): ink drop-fill while deriving keys; ink wipe on unlock; calm lock; error nudge`.

---

### Task 4: Index notes (store and helper)

**Spec:** Section 4, "Index notes", plus the store and identification tests.

**Files:**
- Create: `web/src/lib/indexNote.ts`, `web/src/lib/indexNote.test.ts`
- Modify: `web/src/state/store.ts`
  - `createFolder` creates the Index note after the folder.
  - Add `addDescription(vaultId: string, folderId: string | null): Promise<NoteView>`.
- Test: `web/src/state/store.test.ts`

**Interfaces (produces):**
- `INDEX_TITLE = 'Index'`.
- `indexBody(folderName: string): string`. It returns `` `# ${folderName}\n\nDescribe what lives in this folder.\n` ``.
- `indexNoteOf(tree: TreeView, folderId: string | null): NoteView | null`.
  - It considers non-broken notes with `folderId` equal to the given one and `title === 'Index'`.
  - The oldest `createdAt` wins, with the id as tie-break.
  - `null` means the vault root.
- `isIndexNote(tree: TreeView, note: NoteView): boolean`.
- `store.createFolder(...)` keeps its signature and return type. After the folder exists it calls `createNote(vaultId, folder.id, INDEX_TITLE, indexBody(name))`. A failure there is caught and does not reject `createFolder`; the folder's preview offers "Add description".
- `store.addDescription(vaultId, folderId)`. It creates an Index with `indexBody`, using the folder's name or the vault's name for the root, and returns the note.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - `indexNote.test.ts`:
    - an exact-title match;
    - `index` and `Index ` do not match;
    - the oldest of two wins;
    - root versus folder;
    - broken notes are ignored;
    - deleted or renamed means `null` (Review Focus 1).
  - `store.test.ts`:
    - `createFolder` results in a note titled `Index` in that folder, with the default body;
    - when the Index `createNote` fails (mock the API to reject it once), `createFolder` still resolves and the folder exists;
    - `addDescription` creates an Index at the root and in a folder.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5:** commit `feat(web): Index note per folder (auto-created), indexNoteOf helper, addDescription`.

---

### Task 5: Sidebar tree (Index row style, expand opens Index, new folder opens Index)

**Spec:** Section 4, "Sidebar tree", plus "Created with every new folder" (the navigation part). Section 3's quiet baseline for tree expand and collapse also lands here.

**Files:**
- Modify: `web/src/components/VaultTree.tsx`, `web/src/components/Icons.tsx` (add `IndexIcon`, a 9px diamond), `web/src/styles/shell.css`, and `web/src/pages/VaultPage.tsx` (its root "New folder" path also navigates)
- Test: `web/src/components/VaultTree.test.tsx` (new, or extend if one exists)

**Interfaces:** consumes `indexNoteOf` and `isIndexNote` from Task 4.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - The Index row renders first in its folder with class `tree-index` and the diamond icon. Its label is "Index".
  - Expanding a collapsed folder that has an Index navigates to `/v/{vault}/n/{indexId}`.
  - Expanding while the current route is a note inside that folder does not navigate (Review Focus 3).
  - Collapsing never navigates.
  - Creating a folder through the tree dialog navigates to the new Index, with `state: { fresh: true }` so it opens in edit mode.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3: implement.**
  - Sort notes so the Index comes first.
  - Add the `tree-index` row style: diamond glyph in `--ink-light`, label in `--muted-2`.
  - Animate expand and collapse with a `grid-template-rows: 0fr ↔ 1fr` wrapper around `.tree-group` over `--dur-2`. The chevron rotates over `--dur-2`.
  - Do the navigation in the toggle handler.
- [ ] **Step 4:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5:** commit `feat(web): Index row in the tree, expand/new folder opens Index, animated tree collapse`.

---

### Task 6: Map rendering and motion (quill curves, square folder nodes, write-on, ink draw, pulse)

**Spec:** Section 3, "Map rendering" and "Map motion", plus Section 4, "Map" (Index has no dot; search hits on an Index ink its folder; MapSlip removed; selection callback; double-click fit). Also the map legend removal. Visual reference: `MapP5.dc.html`.

**Files:**
- Modify:
  - `web/src/map/scene.ts`: replace `taperPath` with `curvePath(a, b, bend)` and `chainPath(points, bend)`; add `linkPath`; add `depth` on pencil segments; add the folder node data `{ id, vaultId, x, y, name, depth, noteCount, folderCount }`.
  - `web/src/map/graph.ts` or `useVaultGraphs.ts`: mark Index notes. Index notes are excluded from dots but kept for search inking: a hit on an Index inks `chain` up to its folder.
  - `web/src/map/ConceptMap.tsx`:
    - render curves, link curves and ink;
    - add focusable folder nodes (`g.cmap-folder`, `role="button"`, aria-label "folder {name}, {n} notes") in the roving set;
    - write-on via a module flag;
    - new-ink draw;
    - pulse on an `updatedAt` change;
    - remove `MapSlip` and `MapLegend`;
    - add `onSelect(sel: MapSelection | null)` and `selected` props;
    - double-click a folder or hub to fit;
    - add the pending-links caption.
  - `web/src/map/LocalMap.tsx`: the same curve and square grammar, with no write-on.
  - `web/src/styles/map.css`.
- Delete: `web/src/map/MapSlip.tsx`.
- Test: `web/src/map/scene.test.ts`, `web/src/map/ConceptMap.test.tsx`, `web/src/map/LocalMap.test.tsx` (update the existing tests that assume the slip or the legend; keep their intent through the `onSelect` callback).

**Interfaces (produces):**
- `type MapSelection = { kind: 'note'; vaultId: string; id: string } | { kind: 'folder'; vaultId: string; id: string } | { kind: 'hub'; vaultId: string }`.
- `ConceptMapProps` gains `selected: MapSelection | null` and `onSelect: (s: MapSelection | null) => void`.
  - Selection becomes controlled by the parent (HomePage, Task 7).
  - `Escape` and background clicks call `onSelect(null)`.
- `resetWriteOnForTests(): void` is exported from ConceptMap.tsx. It is for tests only.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - scene:
    - `curvePath` returns `M… Q…`;
    - `chainPath` joins the segments with no extra `M`;
    - folder nodes carry counts;
    - Index notes are not in `dots`, and a hit on an Index id inks its folder chain.
  - ConceptMap:
    - folders render as `g.cmap-folder[role=button]` with the aria-label;
    - arrow-key roving moves between folders and notes;
    - clicking a note or folder calls `onSelect` with the right shape;
    - Escape calls `onSelect(null)`;
    - no `.cmap-slip` and no `.cmap-legend` exist;
    - the write-on classes (`is-writing`) are present on the first mount after `resetWriteOnForTests()` and absent on a second mount (Review Focus 5);
    - an ink path element gets the `ink-draw` class only for newly inked ids across a rerender;
    - the pulse class appears on a dot whose `updatedAt` changed between renders, and not on the first render;
    - the pending caption shows while `linksReady` is false.
  - LocalMap: the parent renders as a square (`.lmap-folder`), and the edges are `path` elements with a `Q` command.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3: implement.**
  - Edge widths, by depth:
    - hub → top folder: 1.5px;
    - folder → subfolder: 1.1px;
    - → note: 0.8px.
  - Hierarchy bend `0.12`, link bend `0.25`, link dash `2 4` with round caps.
  - Ink: 3px, `pathLength="1"`, `stroke-dasharray: 1`, and a `stroke-dashoffset` animation of 1→0 over `--dur-ink`.
  - Folder square: 11px with radius 3. The `.on` state is `rotate(45deg)`, fill `--selection`, border `--map-ink`, with a `--dur-3` transition and a `--dur-3` delay.
  - Write-on: edges get `animation-delay: calc(140ms * depth)` through the React style prop.
  - Pulse: a ~600ms glow keyframe, applied once.
  - Under reduced motion all of these resolve to their final state.
- [ ] **Step 4:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5:** commit `feat(map): quill-curve edges, square folder nodes, write-on, ink draw, drying pulse; slip and legend removed`.

---

### Task 7: Home preview panel and search-row motion

**Spec:** Section 4, "Home right column", plus Section 3, "Search results".

**Files:**
- Create: `web/src/pages/NodePreview.tsx`, `web/src/pages/NodePreview.test.tsx`
- Modify:
  - `web/src/pages/HomePage.tsx`:
    - selection state;
    - three-state right column;
    - "Recently edited" removed;
    - `MapLegend` import removed;
    - search rows get `data-new` for entering ids, plus a first-reveal stagger through a `--i` custom property;
  - `web/src/pages/homeStatus.ts` (add `homeColumn(state, query, selection)` → `'search' | 'preview' | 'empty'`);
  - `web/src/styles/home.css`.
- Test: `web/src/pages/homeStatus.test.ts`, `web/src/pages/NodePreview.test.tsx`

**Interfaces:**
- Consumes `MapSelection` (Task 6) and `indexNoteOf` (Task 4).
- Consumes `renderMarkdown` from `web/src/markdown/render.ts`, `incomingLinks`, and `useVaultGraph`.
- Produces `NodePreview({ selection, onZoom }: { selection: MapSelection; onZoom: (s: MapSelection) => void })`.

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - `homeColumn`:
    - a non-empty query gives `search`, even with a selection;
    - a selection with no query gives `preview`;
    - neither gives `empty`.
  - NodePreview:
    - **note:** title, folder path, "edited …", rendered Markdown (a `<strong>` from `**x**`), backlinks, and links "Open note" (`/v/…/n/…`) and "Edit" (with `state.fresh`, or an edit-mode state);
    - **folder with Index:** renders the Index body, the counts, and a notes list excluding the Index; it has "Open Index", "New note here" and "Zoom to folder";
    - **folder without Index:** shows an "Add description" button that calls `store.addDescription`;
    - **hub:** uses the root Index;
    - **body not decrypted yet:** shows "Decrypting…".
  - HomePage:
    - the empty state text is "Select a folder or note on the map.";
    - there is no "Recently edited";
    - search rows mark only new ids with `data-new`;
    - a selection whose note is deleted (rerender without it) returns to the empty state (Review Focus 2);
    - after a lock (`trees` and `bodies` cleared), no preview text remains.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3: implement.**
  - The preview body uses `renderMarkdown` and `dangerouslySetInnerHTML`, the same pattern as NotePane's article, which is sanitised by DOMPurify.
  - The preview crossfades between selections over `--dur-2`, keyed by the selection id.
  - The column content scrolls inside a max-height box.
- [ ] **Step 4:** run `npm test -w web` and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5:** commit `feat(home): node preview panel replaces Recently edited; search rows ease in`.

---

### Task 8: Quiet baseline and DESIGN.md Motion section

**Spec:** Section 3, "Quiet baseline elsewhere", plus the Testing docs bullet.

**Files:**
- Modify:
  - `web/src/components/AppShell.tsx` (route content wrapper keyed by `location.pathname`, with an enter-only fade and a 2px rise);
  - `web/src/pages/NotePane.tsx` (the segmented highlight slides via a `::before` thumb positioned by `data-mode`; the article and textarea crossfade over 120ms; the save status crossfades, and "Saved" fades in then dims);
  - `web/src/styles/base.css` (button press `scale(.98)` over `--dur-1`), `web/src/styles/note.css`, `web/src/styles/shell.css`;
  - `DESIGN.md` (a new "Motion" section with tokens, rules and reduced motion; the map description updated for curves, square folders and the Index; the legend removed).
- Test: extend `web/src/App.test.tsx` or add `AppShell.test.tsx` (the route wrapper re-keys on navigation, `data-route` changes); NotePane mode toggle (`data-mode` attribute flips).

**Steps:**

- [ ] **Step 1: write the failing tests.**
  - The route wrapper's key or attribute changes when the path changes.
  - The segmented control carries `data-mode="edit"`/`"view"`.
  - The save status element carries `data-save={status}`.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement. CSS uses the tokens only.
- [ ] **Step 4:** run `npm test -w web`, `npm run build -w web` and `npm test -w server`. Expected: PASS.
- [ ] **Step 5:** commit `feat(motion): route fade, edit/view toggle slide, save status, press; DESIGN.md Motion section`.
