# Engraved Atlas Graph Design

## Intent

Give Inked's signed-in concept map the engraved-atlas character approved in the visual mockup: a quiet, chart-like vault frame, distinct hierarchy lines, an unmistakable ink route to the selected note, and legible recency at rest.

## Goals

- Strengthen vault boundaries with a secondary fine ring and a few restrained radial register marks, using the existing boundary geometry and map tokens.
- Make hierarchy, explicit links, and the selected route read as three distinct marks.
- Keep the current graph geometry and interactions: pan, zoom, fit, draggable nodes, keyboard navigation, selection, links, recency, reading progress, ripples, and reduced motion.
- Update the graph section in `DESIGN.md` to match the finished visual grammar.

## Non-goals

- Do not change graph layout, node coordinates, map density, storage, routing, or selection behavior.
- Preserve Inked's original pen-nib logo and wordmark; the atlas treatment applies to the graph surface only.
- Do not add a new color family, map legend, panel, dependency, or decorative animation.
- Do not replace the existing local map on note pages.

## Approach

Build on the existing radial graph renderer. Use each `SceneHub.radius` and focus state for its fine outer and inner boundary marks; refine SVG stroke hierarchy and selected-route prominence in the existing layer order; tune CSS from the current token system. Keep all ornament quiet enough that the nodes and names remain the first read.

## Review criteria

The map should still read at normal Home size and at phone width; multiple vault rings must not overlap unrelated content; selected route, folder hierarchy, and dotted links must remain distinguishable; reduced motion must remain complete without animation.
