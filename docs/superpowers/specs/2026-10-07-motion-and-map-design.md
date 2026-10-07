# Round 3: motion, transitions and map rendering (design)

Date: 2026-10-07. Status: approved in conversation (sections 1–3 and the map choice). Visual reference: design canvas artboard **"Map — CHOSEN · #2 quill curves + #4 square folders"** (`MapP5.dc.html`, canvas version 33). Base docs: `DESIGN.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-10-07-concept-map-design.md`.

## Intent

Inked changes state instantly today: pages, dialogs, menus, results and the map all cut. The owner wants motion that is **quiet, with a few ink accents**:
- fast, functional transitions everywhere;
- a handful of signature ink moments.

The map also gets a new edge and node style.

The owner said:
- the motion should be "Quiet + ink accents";
- the priority areas are Search + map, and Overlays + auth;
- spinners spin too fast today;
- use approach A: CSS tokens, a `usePresence` hook and View Transitions, with no new dependencies;
- folders become nodes, visibly distinct from notes;
- map edges use proposal #2's quill curves, and map nodes use proposal #4's icons.

Success means:
- every listed state change animates within its token durations;
- nothing blocks input or shifts layout unexpectedly;
- reduced motion is respected;
- the map matches the CHOSEN artboard;
- all tests and builds pass;
- there are no new dependencies and no CSP changes.

## Constraints

- No new runtime or dev dependencies.
- CSP stays `style-src 'self'`: no injected `<style>` and no `style` attribute strings. React `style` props and CSS custom properties set through React are fine. View Transition pseudo-elements are styled from stylesheets.
- No server, API or crypto changes.
- Only these properties are animated: `opacity`, `transform`, `clip-path`, SVG `stroke-dashoffset`, and `grid-template-rows` for collapse. Never width or height.
- Nothing bounces or overshoots. The only looping animation is the spinner.
- Animations never block input. A new action cancels or overrides a running animation.

## Section 1: Motion foundation

### Tokens (`web/src/styles/tokens.css`)

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 90ms | hover, press, small exits |
| `--dur-2` | 140ms | fades, small slides, menus |
| `--dur-3` | 200ms | panels and overlays entering |
| `--dur-4` | 320ms | unlock wipe, page-level changes |
| `--dur-ink` | 520ms | ink draws on the map |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` (exists) | entering |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | exiting |
| `--ease-std` | `cubic-bezier(0.2, 0, 0, 1)` | in-place movement |

Exits run at about 70% of the entry duration. All existing hard-coded durations (120ms, 200ms) are replaced by these tokens.

### Helpers (`web/src/motion/`)

- `usePresence(open: boolean, exitMs: number): { mounted: boolean; state: 'enter' | 'open' | 'exit' }`.
  - Components render while `mounted` and put `data-state={state}` on their root. CSS animates `[data-state=enter]` and `[data-state=exit]`.
  - Unmounting waits for `animationend` or `transitionend` on the root, with a timeout of `exitMs + 50`.
  - Re-opening during an exit cancels the exit.
- `prefersReducedMotion(): boolean` and `useReducedMotion(): boolean`. The hook re-renders when the media query changes; a missing `matchMedia` counts as reduced.
- `withViewTransition(update: () => void): void`. Calls `document.startViewTransition(update)` when the API exists and reduced motion is off; otherwise calls `update()` directly.

### Reduced motion

The current blanket rule (everything at 1ms) is replaced. Under `prefers-reduced-motion: reduce`:
- transforms, wipes, ink draws and write-on are disabled;
- opacity transitions stay, capped at 120ms;
- ink paths and dots render in their final state;
- `withViewTransition` skips the transition;
- the spinner pulses its opacity instead of rotating.

## Section 2: Overlays and auth (priority)

- **Dialogs** (native `<dialog>`):
  - Enter: opacity 0→1 and scale 0.98→1, over `--dur-3` with `--ease-out`.
  - Exit: the reverse, over `--dur-2` with `--ease-in`.
  - Built with `@starting-style` and `transition-behavior: allow-discrete` on `display` and `overlay`. The `::backdrop` fades with it.
  - Browsers without support open and close instantly.
  - Focus trap, Esc and backdrop click are unchanged.
- **Menus** (portal):
  - They use `usePresence`.
  - Enter: fade plus scale 0.97→1 from the corner nearest the trigger, over `--dur-2`.
  - Exit: fade only, over `--dur-1`.
- **Banners and the sync bar:** they use `usePresence`.
  - Enter: fade in and slide down 6px.
  - Exit: fade out while the height collapses with `grid-template-rows: 1fr → 0fr`, so the content below eases up.
- **Spinner:** one rotation per 1.2s (currently 0.7s). Under reduced motion it pulses its opacity instead.
- **Unlock (signature):**
  - While the KDF runs, the unlock button shows the Inked drop filling with ink instead of the spinner. It reuses the vault icon's ink-level mask. The fill eases toward 85% over 1.5s and completes when unlock resolves. No progress figure is invented.
  - On success, `withViewTransition` swaps the login screen for the app.
    - `::view-transition-new(root)` animates `clip-path: circle(0 at X Y)` → `circle(150% at X Y)` over `--dur-4`.
    - X and Y are the unlock button's centre, passed through CSS custom properties set on `document.documentElement` from React.
    - The old screen stays underneath.
    - Fallback: a 140ms crossfade. Reduced motion: an instant swap.
- **Lock and sign-out:** a 200ms fade to the login screen with no wipe. The lock notice fades in.
- **Wrong password:** the field shifts 3px sideways once (200ms, no overshoot) and the error text fades in. Reduced motion keeps only the text fade.
- **Register and setup:** the same drop-fill replaces the spinner during key generation, and the recovery-key panel fades in.

## Section 3: Search, map and baseline

### Search results (Home)

- A row that newly enters the result set fades in and rises 4px, over `--dur-2`.
- Rows that stay in the set do not animate.
- The first reveal (empty query → first non-empty) staggers 15ms per row, capped at 8 rows.
- Removed rows disappear immediately.
- The "N matches" count does not crossfade.

### Map rendering (replaces the straight pencil lines and tapered ink polygon)

- **Hierarchy edges:** quadratic "quill" curves, bowed by a control point offset perpendicular to the segment by `0.12 × length`. Stroke width depends on depth:

  | Depth | Width |
  |---|---|
  | hub → top folder | 1.5px |
  | folder → subfolder | 1.1px |
  | → note | 0.8px |

  Colour `--map-pencil`. Widths are in screen pixels, so they don't scale with zoom.
- **`[[link]]` edges:** dotted curves (`stroke-dasharray: 2 4`, round caps), bowed by `0.25 × length`.
- **Ink path:** the same quadratic curves chained hub → folders → note.
  - 3px wide, `--map-ink`, round caps and joins.
  - Drawn with `pathLength="1"`, `stroke-dasharray: 1` and an animated `stroke-dashoffset`.
  - `taperPath` and its tests are removed.
- **Folder nodes:**
  - An 11px rounded square (radius 3px): fill `--panel-3`, 1.5px border `--muted-3`.
  - On an inked path it rotates 45° into a diamond with fill `--selection` and border `--map-ink`. The rotation (`--dur-3`) starts after a `--dur-3` delay, so it lands as the ink reaches the folder.
  - Folders are real nodes:
    - focusable in the same roving tabindex set as notes;
    - `role="button"` with aria-label "folder {name}, {n} notes";
    - click, Enter or Space fits the view to that folder's subtree bounds.
  - The folder label stays below the square, keeping the existing zoom and ink visibility rules.
- **Note nodes:** unchanged. A dot coloured wet → dry with a canvas ring, plus a selection ring when selected.
- **Hub:** unchanged.
- **Local map:** uses the same curve and node grammar.
  - Folder parent = a square.
  - Sibling, incoming and outgoing edges are curves.
  - There is no write-on there.

### Map motion

- **Write-on:** on the first paint of a session (and only then; tracked by an in-memory module flag, never storage), edges draw outward. Each edge has a delay of `140ms × depth` and a duration of `--dur-ink`. Folder squares and dots fade in after their edge.
  - Later visits to Home in the same session render immediately.
  - Reduced motion: no write-on.
- **New ink:** a note that becomes inked (search hit, selected or hot) draws its path over `--dur-ink`. Notes that stay inked do not redraw.
- **Dots:** fade or unfade for search over `--dur-3`. Folder labels fade in and out over `--dur-2`.
- **Drying pulse:** a dot whose `updatedAt` changed while mounted gets one soft glow pulse of about 600ms. It never fires on first render.
- **Selection slip:**
  - Enter: fade plus a 4px rise over `--dur-2`.
  - Exit: fade over `--dur-1`, using `usePresence`.
- **Fit and zoom:** zoom buttons, fit and hub/folder fit keep their 200ms animated fit. Wheel, pinch and drag stay direct.

### Quiet baseline elsewhere

- **Route change:** page content fades in and rises 2px over `--dur-2`. Enter only; leaving does not wait.
- **Sidebar tree:** expands and collapses with `grid-template-rows: 0fr ↔ 1fr` over `--dur-2`. The chevron rotates.
- **Edit/view toggle:** the segmented control's highlight slides over `--dur-2`. The article and textarea crossfade over 120ms.
- **Save status:** the text crossfades. "Saved" fades in, then dims.
- **Hover and press:** colour changes over `--dur-1`. Buttons scale to 0.98 while pressed.

## Section 4: Folder Index notes and the Home preview panel

The owner's point: folder nodes have nothing to describe them. So every folder gets an `Index` note, and Home's right column becomes a preview of the selected node.

### Index notes

- **What an Index is:** an ordinary encrypted note titled exactly `Index` inside a folder; at the vault root, it is the vault's description.
  - It is identified client-side from the decrypted title (case-sensitive `Index`).
  - If a folder holds several, the oldest by `createdAt` is the Index.
  - No server, API or crypto change.
- **Created with every new folder:**
  - `createFolder` is followed by `createNote(vault, folderId, 'Index', body)`, with the body `# {folder name}

Describe what lives in this folder.
`.
  - The new Index opens in the main pane, in edit mode.
  - If creating the Index fails, the folder still exists; the folder's card offers "Add description".
- **Existing folders and the vault root:** nothing is migrated. A folder or vault with no Index shows an "Add description" button in its preview, which creates the Index and opens it in edit mode.
- **Renaming or deleting an Index:** allowed. The folder then has no Index, and "Add description" returns.
- **Links:** `[[Index]]` resolves through the normal title index, so the most recently edited Index wins. Linking a specific folder's Index by path is out of scope.

### Sidebar tree

- The Index row is pinned first in its folder and styled apart from both folders and notes:
  - a 9px ◇ diamond glyph in `--ink-light`, echoing the map's on-path folder diamond;
  - the label "Index" in `--muted-2`, at a row height equal to the other rows.
- **Expanding opens the Index:** expanding a collapsed folder navigates to its Index note, if it has one, unless the current route is already a note inside that folder. Collapsing does not navigate.

### Map

- An Index note gets no dot. The folder square represents it, and the vault hub represents the root Index.
- Search hits on an Index note ink the path to its folder and turn that folder into a diamond.
- The map's selection card (MapSlip) is removed; the preview panel replaces it.
- Clicking a node selects it, shows its ring and ink path, and fills the preview panel.
- A folder's "fit" moves from click to the panel's "Zoom to folder" button and to double-click.

### Home right column (replaces "Recently edited")

The column shows one of three states, in this order of priority:

1. **Search:** while the query is not empty, the column shows search results, unchanged.
2. **Selection:** when a node is selected, it shows a preview panel.
   - **Note:** title, folder path, "edited …", the rendered Markdown (same renderer and sanitizer as the note page), backlinks, and actions **Open note** and **Edit**.
   - **Folder:** folder name and path, the rendered Index (or "Add description"), the count of notes and subfolders, a list of its notes (pinned Index excluded), and actions **Open Index**, **New note here** and **Zoom to folder**.
   - **Vault hub:** the same as a folder, using the root Index.
   - Note text comes from the decrypted bodies already in memory. Bodies that have not finished decrypting show "Decrypting…".
3. **Empty:** when there is no query and nothing selected, a short line: "Select a folder or note on the map."

The "Recently edited" list is removed. The preview crossfades between selections over `--dur-2`, and its content scrolls independently of the page.

## Testing

- **Unit (vitest):**
  - `usePresence` with fake timers: enter → open → exit → unmount; re-open during exit; timeout fallback without `animationend`.
  - `useReducedMotion` with a mocked `matchMedia`, including change events.
  - `withViewTransition` falls back when the API is missing or reduced motion is on.
  - Map:
    - ink paths render only for newly inked ids;
    - write-on runs only on the first render of a session;
    - folder nodes are focusable, take part in arrow-key roving and fit on Enter;
    - folder aria-labels;
    - the drying pulse fires only on an `updatedAt` change.
  - Search rows animate only when their id is new.
- **Browser check (controller):** each priority area in the preview with reduced motion off and on. Nothing shifts layout or blocks clicks. The map matches the CHOSEN artboard.
- **Docs:** `DESIGN.md` gains a "Motion" section with the tokens and rules, and its map description is updated for curves and square folders.

### Additional tests for Section 4

- **Store:** creating a folder creates its Index note; a failed Index creation leaves the folder intact; "Add description" creates an Index.
- **Index identification:** exact title, the oldest Index wins, and root versus folder Indexes are told apart.
- **Map:** an Index note has no dot; a search hit on an Index inks its folder.
- **Home panel:** the three states in priority order, the note preview, the folder preview with and without an Index, the hub preview, and "Decrypting…".
- **Sidebar:** Index pinned first with its own class; expanding a folder navigates to its Index; collapsing does not.

## Out of scope

- Shared-element morphs between routes.
- Spring physics.
- Sound.
- Changes to the map layout algorithm.
- A light theme.
