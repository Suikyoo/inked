---
name: Inked
description: A dark, self-hosted notes app where lilac ink on violet-black paper maps what you wrote, where it lives, and how recently it changed.
colors:
  ground: "#14121a"
  side: "#100e16"
  side-border: "#292431"
  panel: "#1b1822"
  panel-2: "#231f2c"
  panel-3: "#2b2636"
  canvas: "#17131f"
  hover: "#24202d"
  row-selected: "#332744"
  border: "#393344"
  border-2: "#484052"
  line: "#302b3a"
  text: "#e9e4f0"
  text-strong: "#f7f2ff"
  text-2: "#d0c9dc"
  text-body: "#ded8e7"
  muted: "#b1a9bf"
  muted-2: "#968da6"
  muted-3: "#91879e"
  placeholder: "#978ea8"
  ink: "#7150bf"
  ink-hover: "#8464d0"
  logo-ink: "#7452e0"
  ink-light: "#c5a9f6"
  ink-lighter: "#eadcff"
  selection: "#51406b"
  ink-wet: "#eadcff"
  ink-fresh: "#c3a4ef"
  ink-drying: "#a180bf"
  ink-dry: "#8f779f"
  map-pencil: "#655b72"
  map-ink: "#c3a4ef"
  map-sel: "#fff8ff"
  map-link: "#a99aba"
  map-boundary: "rgba(191, 164, 229, 0.17)"
  map-boundary-fill: "rgba(197, 169, 246, 0.018)"
  map-boundary-focus: "rgba(197, 169, 246, 0.34)"
  map-boundary-fill-focus: "rgba(197, 169, 246, 0.045)"
  map-vignette: "rgba(12, 9, 18, 0.34)"
  map-grid: "rgba(206, 189, 232, 0.045)"
  surface-glow: "rgba(174, 137, 255, 0.1)"
  frontboard-atmosphere: "rgba(117, 79, 171, 0.12)"
  gold: "#f2c14e"
  text-inverse: "#fffaff"
  error: "#f2b1c0"
  error-bg: "#2d202d"
  error-text: "#f0d5dc"
  ok: "#9bd7c0"
  warn: "#e1b35c"
  danger: "#8f3e57"
  danger-hover: "#a94a68"
  menu-hover: "#363044"
  sync-bg: "#30212c"
  scroll-thumb-hover: "#51485f"
  text-lead: "#c0b7ce"
  code-text: "#d8d1e3"
typography:
  wordmark:
    fontFamily: "Spectral, Georgia, serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
  vault-title:
    fontFamily: "Spectral, Georgia, serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  vault-name:
    fontFamily: "Spectral, Georgia, serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1
  doc-h1:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  frontboard-title:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "clamp(56px, 9vw, 96px)"
    fontWeight: 600
    lineHeight: 0.93
    letterSpacing: "-0.045em"
  page-title:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  prose:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
  editor:
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  xs: "4px"
  sm: "5px"
  md: "6px"
  lg: "7px"
  xl: "14px"
  card: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  row: "28px"
  row-sm: "26px"
  control: "30px"
  control-lg: "36px"
  side-width: "240px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-default:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  button-default-hover:
    backgroundColor: "{colors.panel-3}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "30px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "0 12px"
  search:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    height: "36px"
  nav-item:
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 8px"
  nav-item-active:
    backgroundColor: "{colors.panel-3}"
    textColor: "{colors.text}"
  tree-row-active:
    backgroundColor: "{colors.row-selected}"
    textColor: "{colors.text-strong}"
    rounded: "{rounded.md}"
    height: "26px"
  card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.card}"
    padding: "18px"
  menu:
    backgroundColor: "{colors.panel-3}"
    rounded: "{rounded.xl}"
    padding: "4px"
  dialog:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "18px"
  map-canvas:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.card}"
---

# Design System: Inked


## Overview

**Creative North Star: "The Inkwell Notebook"**

Inked is a notebook written in lilac ink on violet-black paper. Everything quiet is a tinted surface (never neutral gray, never pure black); one ink hue marks the interactive and the alive. Ink marks the primary action, focus, links, active rows, and the age of notes on the concept map. The logo is a pen nib, each vault is a hexagon mark (a solid core inside an outline) that grows spokes from the bottom up, one per sixth of the notes edited this week, and map dots run from wet to dry ink.

The density is that of a desk tool used daily: a 13px base, 28px rows, 30px controls, a 240px sidebar, and a 700px reading column. Chrome recedes into tonal steps of the same violet; hierarchy comes from text tone (strong, body, muted) and an italic serif voice reserved for names (the wordmark, vault names, vault titles, map hub labels). It is dark only; there is no light theme.

The map is a drawn diagram, not a data-viz widget. Structure is pencil (thin gray-violet quill curves), explicit links are dotted pencil, and recency is ink.

**Key Characteristics:**
- Dark only, tonal layering of violet-black surfaces; no light mode.
- One accent hue (lilac ink) in three working values: fill, text/focus, and highlight; gold remains reserved for reading progress.
- Compact: 13px base, 26-36px rows and controls, 1px borders, small radii.
- Italic Spectral for names; Public Sans for all UI; JetBrains Mono for raw Markdown and keys.
- Flat at rest; shadows only on floating layers.

## Colors

A restrained violet-tinted dark palette with one ink accent and quiet, desaturated status colors.

### Primary
- **Ink Violet** (`ink`, #7150bf): the filled primary button, selected segmented option, and checkboxes. Inverse paper text sits on it; contrast exceeds 5:1. Hover is **Ink Lifted** (`ink-hover`, #8464d0). The original pen-nib mark keeps **Logo Violet** (`logo-ink`, #7452e0).
- **Lilac Ink** (`ink-light`, #c5a9f6): text-level emphasis, links, focus, caret, active icons, and "Open note" actions. **Pale Ink** (`ink-lighter`, #eadcff) is the brightest ink and wettest map tier.
- **Selection Plum** (`selection`, #51406b) for text selection; `mark` uses pale ink at 34% alpha.

### Neutral
- **Ground** (`ground`, #14121a): page background. **Side** (`side`, #100e16) and **Side Border** (`side-border`, #292431) define the sidebar and the region seams.
- **Panel** (`panel`, #1b1822), **Panel 2** (`panel-2`, #231f2c), **Panel 3** (`panel-3`, #2b2636): raised tonal steps. Inputs use panel; notices and dialogs use panel-2; menus, hover fills and active navigation use panel-3. **Canvas** (`canvas`, #17131f) grounds every map mark.
- **Hover** (#24202d) and **Row Selected** (`row-selected`, #332744, a violet-tinted step used for the active tree row).
- **Borders:** `border` (#393344) for controls, `border-2` (#484052) for floating layers, `line` (#302b3a) for quiet rules.
- **Text ramp:** `text-strong` #f7f2ff, `text` #e9e4f0, `text-body` #ded8e7, `text-2` #d0c9dc, `muted` #b1a9bf, `muted-2` #968da6, `muted-3` #91879e, and `placeholder` #978ea8. Tertiary copy and placeholders remain legible on the darker ground.

### Status
- **Error** (#f2b1c0 text; #2d202d surface; #f0d5dc body text) is a soft rose, never saturated red, except the destructive button fill (#8f3e57). **OK** (#9bd7c0) and **Warn** (#e1b35c) are used sparingly.

### Concept map ramp
An ordinal one-hue ramp from wet to dry ink, by age of last edit: **Wet** (`ink-wet`, #eadcff), **Fresh** (`ink-fresh`, #c3a4ef), **Drying** (`ink-drying`, #a180bf), and **Dry** (`ink-dry`, #8f779f). The dry floor stays distinct from pencil even at rest; dots retain 85% opacity. **Pencil** (`map-pencil`, #655b72) draws folder structure; explicit links are dotted pencil curves; **Map Ink** (#c3a4ef) draws the active route. A faint dotted boundary frames each vault and brightens only when the vault is in focus. The map has a restrained drafting grid, soft central wash, and edge vignette beneath the graph. Vault colors are user-chosen data, not palette tokens.

### Named Rules
**The One Ink Rule.** Purple is the only chromatic voice. Status colors are muted and appear only when something is wrong or done; do not introduce a second accent hue.
**The Violet Neutral Rule.** Every neutral carries the violet tint. No `#000`, no gray without hue.
**The Recency Is Ink Rule.** On the map, lightness alone encodes recency, in the four-step ramp. Nothing else on the map may use the ramp hues for meaning, and any new ramp step must be checked against `canvas`.

## Typography

**Display / Name Font:** Spectral italic (500 and 600 only), fallback Georgia, serif
**UI / Body Font:** Public Sans (400, 500, 600, 700), fallback system-ui, Segoe UI, sans-serif
**Mono Font:** JetBrains Mono (400), fallback ui-monospace, Consolas

**Character:** A literary italic serif signs the names that belong to the user (vaults, the app), over a plain, narrow-range grotesque UI. The serif is never used for sentences or controls.

### Hierarchy
- **Wordmark** (Spectral italic 600, 32px on auth screens, 17px in the sidebar, line-height 1): "Inked".
- **Vault title** (Spectral italic 600, 28px, 1.1): vault overview heading. **Vault name** (Spectral italic 500, 14px) in the sidebar and 15px in settings inputs; map hub names 13px, local-map parent 11px.
- **Doc H1** (Public Sans 700, 26px, 1.2, -0.015em); **H2** 17px 600; **H3-H6** 15px 600. All `text-strong`.
- **Page title** (600, 20px). **Dialog / auth title** (600, 15px). **Card title** (600, 14px).
- **Prose** (400, 15px, 1.65, `text-body`, column max 700px; 14.5px under 760px).
- **Body / UI** (400, 13px, 1.4); controls 12-12.5px at 500 weight; inputs 14px.
- **Label** (500, 11px, `muted-2`, sentence case, no tracking): section labels in the sidebar, results, and context panel; hints and counts 11-11.5px in `muted-3`.
- **Editor** (JetBrains Mono 400, 13.5px, 1.75, `text-2`): the raw Markdown pane; also keys and code at 12-14px.

### Named Rules
**The Names Are Italic Rule.** Italic Spectral is for names of things the user owns (vaults, the app). Headings, buttons, and sentences stay Public Sans.
**The Compact Scale Rule.** UI text lives between 11px and 15px; only document headings and the two serif titles go larger.

## Layout

A two-column shell: a sticky 240px sidebar (`side` surface, 12px 10px padding, 14px section gap, 1px rows gap) and a fluid main column. Spacing is a small 4/6/8/12/18/24px rhythm; page gutters are 24px on desktop and 16px on mobile. Rows are 28px (nav) and 26px (tree, ctx); controls are 30px, 36px for fields and the search bar.

**The One Ladder Rule.** The rhythm is a token ladder in `tokens.css`, named for its multiple of 4px (`--sp-4` is 16px): 2, 4, 6, 8, 12, 16, 24, 32, 48. Every gap, margin and padding picks a step; nothing sits between two. A 1px gap is a hairline, a rule's width, not a step, and the tree's 14px indentation per level is structure (`--indent`), not spacing. The openboard sheets are held to the ladder by a test; the rest of the app is still being moved onto it and keeps the 10, 14, 18 and 20px it was drawn with.

- **Home:** padded 18px 24px; a 36px search bar (max 560px, centered) heads the page, then results and the concept map wrap side by side (`flex-wrap`, 20px gap).
- **Public frontboard (`/welcome`):** a scroll-led introduction before the first unlock. The opening pairs a direct promise and unlock action with a large, selectable sample atlas. The map traces one sample note to its folder and reveals a short excerpt; ruled sections explain structure and browser-side encryption. Returning locked users and deep links still go directly to unlock.
- **Note:** document column (flex-grow, 700px content, 44px top bar with breadcrumbs, save status and an edit/view segmented control) plus a 220px+ context panel (outline, properties, local map) on a `side-border` left rule. At 1080px the panel drops below the document in a row.
- **Settings / vault overview:** single centered column, 720px / 760px max.
- **Auth:** centered 320px column (440px wide variant) on `ground`.
- **Small screens (760px):** the sidebar becomes a 300px (max 86vw) off-canvas drawer with a 48px topbar and scrim, row actions always visible, results before the map.
- Reveal-on-hover actions (tree and vault rows) are always visible on touch.

### Reading on the two openboard surfaces

The public page (`/ob`) reads in the **centre**: opening a note rails the concept map to `--map-rail` (200px) and
gives the note the free space, where `.md` and `.ob-reader-head` cap themselves at the 700px reading column the
notes app uses. The map stays clickable as navigation, and `ConceptMap`'s `refitRequest` reframes it on each
reshape — a plain resize only reframes while the viewer has not panned, so without that the rail would show an
arbitrary crop. Switching notes while already reading is not a reshape, so the framing survives it. On a phone
the note is a full-screen overlay already, so the rail does not apply there.

The owner's control (`/openboard`) still reads in a **side drawer** beside its map. The two therefore diverge
on purpose rather than by oversight: the control's job is managing links and content, where the map preview is
the point, and the public page's job is reading. If the control ever wants the same treatment, the pieces are
`ReaderDrawer`'s `centre` prop and `refitRequest`.

## Elevation & Depth

Tonal layering, not shadows. Depth is conveyed by stepping from ground to panel to panel-3 and by 1px borders. Shadows exist only on layers that float over content.

### Shadow Vocabulary
- **Menu** (`box-shadow: 0 12px 28px -12px rgba(0,0,0,.75)`): context menus.
- **Dialog** (`0 24px 48px -16px rgba(0,0,0,.8)`) over a `rgba(10,9,14,.62)` backdrop.
- **Drawer** (`16px 0 40px -20px rgba(0,0,0,.8)`) and scrim `rgba(10,9,14,.55)`.
- **Focus** (`0 0 0 1px ink-light, 0 0 0 3px rgba(182,156,255,.18)`) on field wrappers.

### Named Rules
**The Flat-Until-Floating Rule.** Cards, panels, and rows have no shadow. Only menus, dialogs and the drawer lift, with large soft negative-spread shadows, never offset hard shadows.

## Shapes

Small, consistent radii on a hairline-bordered rectilinear system: 4px (code, kbd, inline controls), 5px (icon buttons, menu items), 6px (buttons, rows, nav), 7px (inputs, segmented), 8px (search, menu, banners, code blocks), 10px (cards, dialogs, recovery panel, map frame). Swatches are circles. Borders are 1px in `border` / `side-border`; inputs on panel surfaces may render their border as a 1px box-shadow ring. Icons are stroked line SVGs (`currentColor`, round caps and joins, 1.8-2.6 stroke at 14px) in a single family; the nib logo is a filled mark, and the vault icon is the same stroked family: an outline hexagon, up to six spokes and a solid hexagon core, with no translucent fills.

## Components

### Buttons
- **Shape:** 6px radius, 30px high (28px small, 34px block), 12.5px / 500.
- **Default:** `panel` fill, 1px `border`, hover `panel-3`. **Primary:** ink fill and border, white text, hover ink-hover. **Danger:** `danger` (#8f3348) fill, `danger-hover` (#a33c54) on hover, white text; **quiet danger:** transparent, error text, `error-bg` on hover. Disabled is 55% opacity.
- **Icon button:** 24px (22 / 20 small), transparent, 5px radius, `muted-2` text, hover `panel-3`. Color changes take `--dur-1`; pressing scales a button to 0.98.

### Inputs / Fields
- 36px high (30px small), 14px text, `panel` fill, 1px `border`, 7px radius; placeholder `placeholder`. Label 12px/500 `muted`, hint 11.5px `muted-3`, 6px label gap.
- **Focus:** border or ring becomes `ink-light` with an 18% lilac glow. Errors are rose text with a leading icon, never a red border. Inside cards, fields sit on `ground`.
- Password fields carry a trailing 28px action button. Checkboxes use `accent-color: ink`.

### Navigation (sidebar and tree)
- A folder's Index is the first row in its tree, marked with a lilac ◇ diamond in the chevron slot and `muted-2` text.
- Nav items: 28px, `text-2`, 6px radius; hover `hover` fill; active/current `panel-3` with the icon turned lilac. Vault rows pair the ink-drop icon, the italic name, and a muted count that swaps for hover actions.
- Tree rows: 26px, 12.5px, a 12px chevron, indentation 14px per level under a 1px `line` guide; active row `row-selected` with `text-strong`; keyboard focus shows a 2px lilac outline inset.

### Search
- 36px, 8px radius, `panel` fill, a leading icon, and a trailing `kbd` hint hidden on focus. Results are 6px 8px rows with title (13px), meta (11.5px `muted-2`) and a 2-line snippet (12px `muted`), with matches highlighted by `mark`.
- **Search by meaning.** Opt-in (Settings). Home shows one merged list of title, note-text and meaning matches. Each row ends in a muted 11px `res-why` tag (`title`, `text`, or `◇ meaning` in `ink-light`); meaning rows show the best chunk's first line as their snippet. While focus is inside the list the order holds still, and new results apply when focus leaves or the query changes. When meaning indexing is incomplete the header adds "· meaning covers 3 of 40 notes", and a 2px progress bar under the search bar reads "Indexing by meaning · 3 / 40" (or "Downloading model · 12 / 90 MB"), fading out over `--dur-3` once done. Off by default, none of this shows.

### Segmented control
- 2px inset on `panel` with a 1px `line` border; 24px options; the pressed option has white text over an ink thumb that slides between the options over `--dur-2` (the control carries `data-mode`). Used for edit / view; the article or textarea fades in over 180ms.

### Menus and dialogs
- Menu: 188px wide, `panel-3`, 1px `border-2`, 8px radius, 30px items, danger items in error rose. Dialog: native `<dialog>`, 400px max, `panel-2`, 10px radius, 18px padding, title 15px/600, right-aligned actions, 8px gap.

### Cards and notices
- Card: `panel`, 1px `side-border`, 10px radius, 18px padding, 12px internal gap. Banner / notice: `panel-2`, 8px or 6px radius, 12.5px text. Alert: `error-bg` with `error-text`, no border. Sync bar: 32px, `sync-bg` (#30212c) with `error-text`.

### Concept map (signature)
A `canvas` frame with a 1px `side-border`, 10px radius, aspect 100:60 (min 320px), pan and zoom by drag, with 24px square tool buttons at the top right. The canvas carries a low-contrast drafting grid, a central wash, and an edge vignette under the SVG. Each vault receives an engraved boundary keyed to its existing layout radius: a faint outer dotted ring, a finer inner ring at 78% radius, and twelve short register ticks, with four cardinal ticks slightly longer. The focused vault's marks brighten together. Notes are 8px round markers (r=4, r=5 for larger nodes) inside a 24px hit target (r=12), each with a 2px surface ring (stroke `canvas`, painted behind) so dots stay legible over lines. Folders are rounded squares (`panel-3` fill, `muted-3` stroke, about 9.5px) inside a 22px hit target (r=11); on an inked path a folder turns into a diamond as the ink arrives. Every folder's `Index` note has no dot of its own: a hit on it inks the path to its folder (the diamond), and a vault's root Index lights the hub, which stands for it. Labels are 10.5px Public Sans with a canvas halo; vault hubs carry an italic serif name and the ink-drop icon. Edges are quill curves, not straight lines: folder structure draws as pencil curves (1.5px hub to top folder, 1.1px folder to subfolder, 0.8px to a note), explicit links as subtler dotted pencil curves (`2 4`, round caps) bowed more than the hierarchy, and selected ink paths as the same curves joined end to end at 3.25px. Selection is a `map-sel` ring at r+3; unselected neighbors fade to 30%. The count line identifies the number of vaults, notes, and folders. There is no slip card and no legend: selecting a node shows it in the Home preview panel beside the map, which replaces "Recently edited" and holds the node's rendered Index or note, its notes, backlinks, "Open note" / "Open Index", and "Add description" where a folder or vault has no Index. The local map on the note page uses the same grammar at 220px width: 4.5px center dot with an 8px ring, 3px child dots, 10px labels, captions ("links in", "same folder", "links out") in sentence-case `muted-3` with no tracking. Text below the 11px type floor is limited to four places: concept-map labels (10.5px, dense SVG with a canvas halo), local-map labels (10px) and the local map's overflow count (9px), both because the panel is only 220px wide and carries up to 12 rows, and `kbd` key caps (10.5px).

**Lit state.** Hovering or focusing a note dot (or selecting a note) lights it and what it is tied to: its ink path, linked notes and its meaning neighbours. Everything else dims (notes to 30%, folders and pencil to 45%, links to 35%), and the links of the lit node flow toward it as a dash that runs along the curve. Hover is applied once per animation frame. While a search is active nothing dims, because search already fades non-hits.

**Click sequence.** Clicking a note selects it, in this order: a ring spreads from the dot (`cmap-ring`, 4.5x, fades), the ink path to it draws, then its meaning threads. The ring plays when the selection changes after mount, from any source (map, list or keyboard), not on first render.

**Density rings and hollow orphans.** A note's link count shows around its dot, in its ink tier: no links draws a hollow ring (r 3.4, stroke in the tier ink, canvas fill), one link is a plain dot, two links add one thin ring (r 6.5), three or more add two (r 6.5 and 9.25). Nothing is drawn until the vault's note text is decrypted, since links are not known before that; a caption says so.

**Meaning threads.** Whenever stored vectors exist (even with the semantic search toggle off), the lit note draws dotted `ink-wet` threads to its three nearest notes by meaning, bowed apart from the pencil links. Each thread draws in over 640ms behind a mask, staggered 90ms apart and starting 560ms after the ink path. Each neighbour's dot pulses once as its thread arrives (scale 1.7 over 420ms), and its label gains a "◇ .82" similarity.

**Live ripples.** When a note is saved (here, in another tab, or on another device), its dot flashes to `ink-lighter` for one frame and eases back to its tier over 1800ms, two `ink-wet` rings spread from it (r 5, scaling to 5.5x over 1100ms, the second 200ms after the first), and each folder square on its path ticks to a 3px `ink-wet` stroke over 700ms. At most 6 notes ripple at once, staggered 120ms apart; further saved notes only flash. Notes not on the map are ignored. Saves made while Home was not open ripple once when it opens, after the write-on has finished.

**Reduced motion.** No rings, no flowing links, no threads' draw-in and no pulses. The folder tick shrinks to a 120ms stroke colour change. The lit state still dims and lights, the save flash still plays: the dot jumps to `ink-lighter` at once and its fill settles back to its tier over 120ms rather than 1800ms (only the dots keep a fill transition), and selection is still conveyed by the ink path and the selection ring.

## Motion

Motion is quiet and tied to the ink metaphor: it confirms a change of state and never blocks a click or shifts layout.

### Tokens
- **Durations:** `--dur-1` 200ms (hover, press), `--dur-2` 320ms (route, toggle, tree, banners, menus), `--dur-3` 450ms (dialogs opening, the mobile drawer, panels, the auth fade, the write-on node fade), `--dur-4` 650ms, `--dur-ink` 750ms (ink drawn along a path on the map).
- **Easing:** `--ease-out` cubic-bezier(0.16, 1, 0.3, 1) for things arriving, `--ease-in` cubic-bezier(0.4, 0, 1, 1) for things leaving, `--ease-std` cubic-bezier(0.2, 0, 0, 1) for things that move between two places.

### Rules
- **Route change:** content fades in and rises 2px over `--dur-2`. Enter only; leaving never waits. The same fade plays when the app shell first mounts after unlock, which is also the fallback when View Transitions are unavailable.
- **Sidebar tree:** folders expand and collapse over `--dur-2` and the chevron rotates.
- **Edit / view:** the segmented thumb slides over `--dur-2`; the article or textarea fades in over 180ms.
- **Save status:** the new text fades in; "Saved" fades in, then dims slightly.
- **Hover and press:** color changes over `--dur-1`; buttons scale to 0.98 while pressed.
- **Banners and notices:** collapse in and out, holding their last content while they close.
- **Map:** edges write on once per session, ink draws along a path over `--dur-ink`, and a saved note ripples (see Live ripples under Concept map).
- **Vault icon:** on a vault row (the sidebar, and the openboard rail and published-content tree) and on the map hub. Nowhere else, and never with a level it has not been given: the spoke count is always `activeNoteCount7d / max(noteCount, 1)`, from one shared rule (`state/vaultStats.ts`). Hovering or focusing the row or hub turns the outline hexagon 60° over `--dur-3` (`--ease-std`), which lands on the same shape, like a dial; it turns back on leave. A click rushes ink: the unlit spokes draw in, hold and draw back out over 760ms (`--ease-std`) while the core pulses once, so the real level always stays drawn. Reduced motion drops both.
- Animate opacity and transform, and color on hover. The exceptions are `clip-path` (the unlock wipe), SVG `stroke-dashoffset` (map ink and write-on) and `grid-template-rows` (tree collapse, banners). Never width, height or position.

### Reduced motion
Under `prefers-reduced-motion: reduce`, every animation runs for 1ms with no delay and transitions are limited to opacity, color, background-color and border-color at 120ms. The loops kept are the spinner's gentle opacity pulse and the `.ink-fill` pulse. Nothing is conveyed by movement alone.

## Do's and Don'ts

### Do:
- **Do** build new surfaces from the tonal ladder: ground, panel, panel-2, panel-3, with 1px `border` / `side-border` lines and no shadow.
- **Do** use ink-light (#c5a9f6) for text-level emphasis and the 2px focus ring, and Ink Violet fill for the one primary action per view.
- **Do** keep controls at 30px (36px for fields) and rows at 26-28px, with 12.5-13px text.
- **Do** set vault and app names in Spectral italic and everything else in Public Sans; set raw Markdown, keys and code in JetBrains Mono.
- **Do** validate any new map color against `canvas`, keep the 24px hit target around each 8px marker, and give map text a canvas halo.
- **Do** honor `prefers-reduced-motion` and build motion from the `--dur-*` and `--ease-*` tokens (see Motion).
- **Do** keep icon sets as stroked `currentColor` line SVGs.

### Don't:
- **Don't** add a second accent hue or use saturated red for errors; use the rose ramp.
- **Don't** use pure black, pure gray, or any neutral without the violet tint.
- **Don't** lift cards or rows with shadows; only floating layers (menu, dialog, drawer) get one, soft and negative-spread.
- **Don't** use the serif italic for sentences, buttons, or headings.
- **Don't** encode map recency with anything but the wet-to-dry lightness ramp, or add ramp steps without checking them against `canvas`.
- **Don't** add a light theme without redoing the tokens; the system is dark only.

<!-- Design debt cleared in the 2026-10-07 cleanup round: the off-token hex literals (sync bar, danger, auth lead, menu hover, scrollbar thumb, code text) are now tokens in tokens.css, the dashed missing-link border uses map-pencil, and the local-map caption is 10px sentence case. The sub-11px text (map labels 10.5px, local-map labels 10px, its overflow count 9px, kbd 10.5px) is the deliberate exception to the 11px floor. -->
