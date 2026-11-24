# Engraved Atlas Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine Inked's signed-in concept graph to the approved engraved-atlas direction while retaining its existing map behavior.

**Architecture:** Keep `buildScene` and all graph coordinates unchanged. Add fine vault register marks in `ConceptMap.tsx`, tune the existing SVG layer and node styling in `map.css`, then document the final grammar in `DESIGN.md`.

**Tech Stack:** React, TypeScript, SVG, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-11-24-engraved-atlas-design.md`

## Global Constraints

- Preserve current graph geometry, selection, pan/zoom, drag, keyboard navigation, recency, progress, ripples, and reduced-motion behavior.
- Preserve the original Inked pen-nib logo, wordmark, and logo color.
- Use existing design tokens and keep the map dark, violet-tinted, and legible.
- Do not change the note-page local map.
- Do not add or run automated tests.

## Review Focus

- Multiple vaults: their boundaries and register marks must remain visually separate.
- Dense graphs: labels, note markers, and folder nodes must remain readable over the new marks.
- Selected note: the continuous route must be clearly distinct from hierarchy and dotted links.
- Reduced motion: all graph states must remain clear when animation is disabled.
- Narrow viewport: map controls and metadata must stay within the map frame.

---

### Task 1: Refine the atlas SVG marks

**Files:**
- Modify: `web/src/map/ConceptMap.tsx`

**Steps:**
- [x] Add a secondary fine vault ring and restrained radial register ticks from each hub's existing center and radius; keep them in the boundary layer beneath graph edges.
- [x] Preserve the existing focused-vault boundary state and ensure added marks are decorative and non-interactive.

### Task 2: Establish graph stroke hierarchy

**Files:**
- Modify: `web/src/styles/map.css`

**Steps:**
- [x] Style the secondary rings and register ticks with tokenized boundary colors and non-scaling SVG strokes.
- [x] Tune pencil, dotted links, selected route, markers, and vault rings to match the approved mock's visual hierarchy without changing semantics or animation timing.
- [x] Keep reduced-motion behavior complete and tune responsive meta/control positioning only if needed after render review.

### Task 3: Preserve the original brand mark

**Files:**
- Modify: `web/src/brand/Logo.tsx`
- Modify: `web/public/favicon.svg`
- Modify: `web/src/styles/tokens.css`
- Modify: `DESIGN.md`
- Modify: `.superpowers/brainstorm/509-1795501775/content/engraved-atlas.html`

**Steps:**
- [x] Give the existing pen-nib mark a dedicated original-color token; keep the app wordmark untouched.
- [x] Keep the favicon on the same original-color pen-nib mark.
- [x] Make the standalone atlas mock display that same mark instead of a placeholder glyph.

### Task 4: Document and visually review

**Files:**
- Modify: `DESIGN.md`

**Steps:**
- [x] Update the Concept Map design section with the final vault ring and mark hierarchy.
- [x] Run `npm run build -w web`; expected: successful production build.
- [x] Review the approved atlas mock at desktop and narrow viewports; confirm boundary scale, route, link lines, and controls remain legible. Confirm no new motion was introduced, so the existing reduced-motion rules remain complete.
