# Map cues and motion (round 4b): design

Status: approved in conversation on 2026-10-08.

This depends on round 4a (`2026-10-08-semantic-search-design.md`), but only for meaning threads. Everything else stands alone.

Live examples (with made-up similarity values) are on the "Inked Map Candy" artifact: https://claude.ai/artifact/EmSkTvskCtVCesTcEuCzxZ. The user picked:
- live ripples;
- hover focus;
- link density;
- meaning threads.

They turned down the folder ink wash, the paper texture and the ink bleed on hover.

## Goal

The Home concept map should show more at a glance (how well connected a note is and what it relates to by meaning) and should react with ink motion when you select a note or when a note is saved. It keeps the round-3 language: quill curves, square folders that become diamonds, and the 520–560 ms ink draw.

## 1. The lit state

A note is *lit* when it is selected or focused. Its lit set is:
- the note itself;
- its `[[link]]` neighbours, in and out, from `graph.ts`;
- its up to 3 meaning neighbours (Section 4).

The folders on their paths are lit too.

While a note is lit:
- notes outside the lit set dim to `opacity: .3`, and folders, labels and edges outside it dim to `.45`, over `--dur-3`;
- static `[[link]]` dotted lines dim to `.35`, and the note's own links are drawn on top as flowing dashes (`stroke #8D7BC4`, width 1.3, `2 4` dashes, moving toward the lit note, 1.4 s linear loop);
- labels appear for the lit note and its neighbours, and meaning neighbours get ` · ◇ .82` (similarity to two decimals, leading zero dropped).

**Focus source.** In priority order:
1. the hovered or keyboard-focused note dot;
2. the existing `hot` prop (the result row under the pointer);
3. the selected note.

When the pointer or focus leaves, the lit state falls back to the selection, or clears.

**While searching** (the query is non-empty), focus and hover are off, because search already dims the map. A selection made during search still runs the click sequence (Section 2).

This applies only to note dots. Folders and the hub keep their round-3 behaviour (diamond path, preview).

## 2. The click sequence

Selecting a note runs one shared sequence, however the selection was made:
- clicking a map dot;
- a search result;
- a Related row in the preview;
- a sidebar tree link that lands on Home with that note selected.

The sequence:

1. **Ring:** one ink ring spreads from the dot (scale 1 → 4.5, opacity .7 → 0, 700 ms, `--ease-out`).
2. **Ink path:** the existing hub-to-note ink path draws (560 ms), and folders turn into diamonds as the ink reaches them (round 3, unchanged).
3. **Threads:** when the ink arrives, meaning threads draw out to each neighbour, 640 ms each, staggered 90 ms.
4. **Pulse:** each meaning neighbour's dot pulses (scale 1 → 1.7 → 1, 420 ms) as its thread arrives (delay 520 ms + 90 ms × i, measured from the start of the thread draw).
5. **Lit state:** the lit state (Section 1) holds until the selection changes or is cleared.

Hover and focus run steps 3–5 only, with no ring and no ink path.

A focus change mid-sequence restarts steps 3–5 for the new focus. The ink path belongs to the selection only.

## 3. Link density

This is always visible, whether or not anything is lit. The count is `[[links]]` in plus out, from `graph.ts`:
- **0 links:** hollow dot, with the dot's colour as a 1.4 px stroke over the panel fill and a 3.4 px radius;
- **1 link:** a plain dot (unchanged);
- **2 links:** one ring at r 6.5, 1.25 px, in the dot's own wet/dry colour;
- **3 or more links:** two rings, at r 6.5 and r 9.25.

The selection ring moves outside the density rings (r 7 for a plain dot, r 9 with one density ring, r 11.5 with two).

`SceneDot` gains `degree: number`. The aria-label gains the link count: "note {title}, {n} links", using "1 link" in the singular and leaving out the count when it is 0.

## 4. Meaning threads

- **Source.** Whole-note mean vectors from round 4a (`meanVector`, fresh vectors only, floor 0.55), top 3. Only notes drawn on the current map are candidates, so neighbours in other vaults are skipped.
- **Availability.** Threads are hidden, with no placeholder, when the lit note or its candidates have no fresh vector. They need neither the model nor the Settings toggle, because they use only stored vectors.
- **Drawing.**
  - A `0.35`-bend quill curve, which is a different curvature from links (`0.25`) and the hierarchy (`0.12`).
  - Dotted beads: `stroke --ink-wet` at .75 opacity, width 1.6, dash `.1 5` with round caps, flowing outward from the lit note (2.2 s linear loop).
  - The draw-in is a mask path animated from `stroke-dashoffset` 1 to 0 with `pathLength=1`.
- **Computation.** Run once per lit note and memoised by `(noteId, vectorsVersion)`. Brute force over the map's notes takes well under 5 ms at 200 notes.

## 5. Live ripples on save

- **Event.** The store emits `notesSaved(ids: string[])` whenever a note's new `updated_at` lands. The sources are:
  - this tab's queue flush;
  - `refreshNoteHead`;
  - a tree refresh that finds a newer `updated_at`, from another tab or device, or MCP.

  The live-watch spec will later reuse this event.
- **While Home is mounted**, each saved note plays:
  - two rings (scale 1 → 5.5, opacity .75 → 0, 1100 ms, the second delayed 200 ms);
  - a dot flash: the fill jumps to `--ink-lighter` with no transition, then eases back to its wet/dry colour over 1800 ms;
  - a tick on each folder along the path: the stroke flashes `--ink-wet` with a 3 px weight, then settles (700 ms).
- **Return ripples.** Notes saved while Home was not mounted are kept as a session-local list (ids only, in memory). When Home mounts, they ripple once after the write-on finishes, or straight away if the write-on already played this session. Then the list is cleared.
- **Burst cap.** At most 6 notes ripple at once, started 120 ms apart. Any beyond the cap get only the dot flash and folder tick. The cap and stagger are constants (`RIPPLE_MAX = 6`, `RIPPLE_STAGGER_MS = 120`).
- **Exclusions.** A save of a note not on the current map does nothing visible. Locking clears the pending list.

## 6. Reduced motion, performance, scope, testing

**Reduced motion** (`prefers-reduced-motion: reduce`):
- no rings and no pulses;
- links and threads are drawn static (no flow, no draw-in);
- dimming is instant;
- the save flash becomes a plain fill change that settles after 120 ms;
- the folder tick becomes a 120 ms stroke colour change.

**Performance:**
- Lit-state changes toggle classes on existing elements and never re-render the whole SVG.
- Only the flowing-link, thread and ring layers are re-rendered.
- Hover is throttled to one update per animation frame.

**Scope:**
- Home's `ConceptMap` only. The note page's `LocalMap` is unchanged.
- Folder hover is out of scope.

**Testing** (vitest + jsdom, using the round-3 patterns):
- `scene`: degree counts and density classes (0, 1, 2, 3+); selection ring radius by degree; the singular/plural aria-label.
- `litSet(focus, graph, neighbours)`: links in and out, meaning neighbours, lit folders.
- `meaningNeighbours`: top-3 with the floor, the current-map filter, stale vectors excluded, hidden with no vectors (fake deterministic vectors).
- Focus priority: hover, then `hot`, then selection; off while searching; falls back to the selection when the pointer leaves.
- Click sequence classes and delays: ring, ink, then threads and pulses with the right delays; a focus change restarts the threads.
- Ripple queue:
  - the cap of 6;
  - the 120 ms stagger;
  - flash-only beyond the cap;
  - return ripples after the write-on;
  - an off-map id ignored;
  - the list cleared on lock.
- `notesSaved` is emitted from the queue flush, from `refreshNoteHead`, and from a tree refresh with a newer `updated_at`.
- Reduced motion: the static classes are present and no ring elements are created.
- Manual check on the `inked-test` stack:
  - click, hover and Tab through notes;
  - save from a second tab and watch the ripple;
  - return to Home after editing.
