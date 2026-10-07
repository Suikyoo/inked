import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { VaultIcon } from '../brand/VaultIcon';
import { FitIcon, MinusIcon, PlusIcon } from '../components/Icons';
import { relativeTime } from '../lib/util';
import { prefersReducedMotion, usePresence } from '../motion';
import { inkTier } from './recency';
import { arrowDir, buildScene, chainPath, curvePath, edgeWidth, HIERARCHY_BEND, linkPath, nearestInDirection } from './scene';
import { fit, panBy, toScreen, useViewport, zoomAt, type Bounds, type Size } from './useViewport';
import type { MapEntry } from './useVaultGraphs';

const FALLBACK: Size = { w: 800, h: 480 };
const DRAG_PX = 4;
const LABEL_SCALE = 1.6;
/** Below this zoom, folder labels crowd the dots, so only those on an inked path are drawn. */
const FOLDER_LABEL_SCALE = 0.9;
const STEP = 1.25;
const EDGE = 16;
/** Write-on: each level of edges starts this much after the one above it. */
const WRITE_STEP_MS = 140;
/** Write-on: a folder square or dot fades in this long after its edge starts drawing. */
const NODE_LAG_MS = 260;
/** The pending-links caption fades out over --dur-2. */
const CAPTION_EXIT_MS = 140;

export const noteHref = (vaultId: string, noteId: string) => `/v/${vaultId}/n/${noteId}`;

/** What is selected on the map. The parent owns it (Home shows it in the preview panel). */
export type MapSelection = { kind: 'note'; vaultId: string; id: string } | { kind: 'folder'; vaultId: string; id: string } | { kind: 'hub'; vaultId: string };

/** The write-on plays on the first map paint of a session only: an in-memory flag, never storage. */
let wroteOn = false;
/** Lets a test see the write-on again. Not for app code. */
export function resetWriteOnForTests(): void {
  wroteOn = false;
}

export interface ConceptMapProps {
  entries: MapEntry[];
  /** Note ids matching the current search. */
  hits: ReadonlySet<string>;
  /** Note under the pointer or focus in the results list. */
  hot: string | null;
  loading: boolean;
  selected: MapSelection | null;
  /** Called with the clicked node, or null when Escape or a background click clears the selection. */
  onSelect: (s: MapSelection | null) => void;
  now?: number;
}

const f1 = (n: number) => n.toFixed(1);
const ms = (n: number) => `${n}ms`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function ConceptMap({ entries, hits, hot, loading, selected, onSelect, now = Date.now() }: ConceptMapProps) {
  const navigate = useNavigate();
  const uid = 'cm' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const [size, setSize] = useState<Size>(FALLBACK);
  const scene = useMemo(() => buildScene(entries), [entries]);
  const { view, setView, animateTo } = useViewport(() => fit(scene.bounds, FALLBACK));
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
  const folderById = useMemo(() => new Map(scene.folders.map((f) => [f.id, f])), [scene]);
  const isNode = (id: string | null): id is string => !!id && (dotById.has(id) || folderById.has(id));
  const selNote = selected?.kind === 'note' && dotById.has(selected.id) ? selected.id : null;
  const selFolder = selected?.kind === 'folder' && folderById.has(selected.id) ? selected.id : null;
  const selHub = selected?.kind === 'hub' && entryById.has(selected.vaultId) ? selected.vaultId : null;

  // Write-on: decided at the first paint that has edges to draw, so a map that opens on
  // "Decrypting…" still writes on when the notes arrive. Reduced motion skips it.
  const writeOn = useRef<boolean | null>(null);
  if (writeOn.current === null && scene.pencil.length > 0) writeOn.current = !wroteOn && !prefersReducedMotion();
  const writing = writeOn.current === true;
  useEffect(() => {
    if (writeOn.current !== null) wroteOn = true;
  });

  // Drying pulse: the updatedAt each dot first rendered with. A later change pulses the dot once.
  const firstSeen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const d of scene.dots) if (!firstSeen.current.has(d.id)) firstSeen.current.set(d.id, d.updatedAt);
  }, [scene]);

  // The svg is absolutely positioned, so the frame alone decides the size: measure it now, then follow it.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      if (w > 0 && h > 0) setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    const box = el.getBoundingClientRect();
    apply(box.width - 2 * el.clientLeft, box.height - 2 * el.clientTop);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((items) => {
      const r = items[0]?.contentRect;
      if (r) apply(r.width, r.height);
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
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      // The button was released off the map before a drag began; no pointerup reached us.
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      drag.current = null;
      setDragging(false);
      return;
    }
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
  const fitTo = (b: Bounds | undefined) => {
    if (!b) return;
    touched.current = true;
    animateTo(fit(b, size));
  };

  const shown = useMemo(() => scene.dots.map((dot) => ({ dot, ...toScreen(view, dot) })), [scene, view]);
  /** Every focusable node (notes and folders) in screen space, for arrow-key roving. */
  const targets = useMemo(
    () => [...shown.map((s) => ({ id: s.dot.id, x: s.x, y: s.y })), ...scene.folders.map((f) => ({ id: f.id, ...toScreen(view, f) }))],
    [shown, scene, view],
  );
  const firstHit = useMemo(() => {
    for (const id of hits) if (dotById.has(id)) return id;
    return null;
  }, [hits, dotById]);
  const recentId = useMemo(
    () => scene.dots.reduce<string | null>((best, d) => (best === null || d.updatedAt > dotById.get(best)!.updatedAt ? d.id : best), null),
    [scene, dotById],
  );
  const rovingId = (isNode(focusId) ? focusId : null) ?? selNote ?? selFolder ?? firstHit ?? recentId ?? scene.folders[0]?.id ?? null;

  /** Pans a node that lies outside the view to the centre. Asking twice for the same node is harmless. */
  const revealNode = (id: string) => {
    const p = dotById.get(id) ?? folderById.get(id);
    if (!p) return;
    const s = toScreen(view, p);
    if (s.x < EDGE || s.y < EDGE || s.x > size.w - EDGE || s.y > size.h - EDGE) {
      touched.current = true;
      animateTo(panBy(view, size.w / 2 - s.x, size.h / 2 - s.y));
    }
  };
  const focusNode = (id: string) => {
    setFocusId(id);
    revealNode(id);
    nodeRefs.current.get(id)?.focus({ preventScroll: true });
  };
  const nodeRef = (id: string) => (el: SVGGElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };
  const nodeFocusProps = (id: string) => ({
    tabIndex: id === rovingId ? 0 : -1,
    onFocus: () => {
      setFocusId(id);
      revealNode(id);
    },
    onBlur: (e: { relatedTarget: EventTarget | null }) => {
      const next = e.relatedTarget;
      if (!(next instanceof Element && next.closest('g.cmap-node, g.cmap-folder') && svgRef.current?.contains(next))) setFocusId(null);
    },
  });

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const dir = arrowDir(e.key);
    // Ctrl/Meta/Alt with + - 0 is browser zoom and Alt+Arrow is browser history; leave them alone.
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (dir && plain) {
      e.preventDefault();
      const from = targets.find((t) => t.id === rovingId);
      if (!from) return;
      const next = nearestInDirection(from, targets, dir);
      if (next) focusNode(next);
    } else if (plain && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      zoomBy(STEP);
    } else if (plain && e.key === '-') {
      e.preventDefault();
      zoomBy(1 / STEP);
    } else if (plain && e.key === '0') {
      e.preventDefault();
      fitAll();
    } else if (e.key === 'Escape' && selected) {
      e.preventDefault();
      onSelect(null);
    }
  };
  const activates = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  const onDotClick = (e: MouseEvent<SVGGElement>, vaultId: string, id: string) => {
    e.stopPropagation();
    if (consumeDrag()) return;
    onSelect({ kind: 'note', vaultId, id });
    setFocusId(id);
  };
  const onFolderClick = (e: MouseEvent<SVGGElement>, vaultId: string, id: string) => {
    e.stopPropagation();
    if (consumeDrag()) return;
    onSelect({ kind: 'folder', vaultId, id });
    setFocusId(id);
  };
  const onHubClick = (e: MouseEvent<SVGGElement>, vaultId: string) => {
    e.stopPropagation();
    if (consumeDrag()) return;
    onSelect({ kind: 'hub', vaultId });
  };
  const onBackgroundClick = () => {
    if (consumeDrag()) return;
    if (selected) onSelect(null);
  };

  // Ink: search hits (an Index hit inks its folder's path), the selected note or folder, and the hot result.
  const inked: string[] = [];
  const inkOnce = (id: string | null) => {
    if (id && scene.chains[id] && !inked.includes(id)) inked.push(id);
  };
  for (const id of hits) inkOnce(id);
  inkOnce(selNote);
  inkOnce(selFolder);
  inkOnce(hot);
  const inkedNotes = new Set(inked.filter((id) => dotById.has(id)));
  const inkedFolders = new Set<string>();
  for (const id of inked) for (const fid of scene.chainFolders[id] ?? []) inkedFolders.add(fid);

  // Ink present on the first render is drawn as is; ids inked later draw in. An id that leaves and returns draws again.
  const settledInk = useRef<Set<string> | null>(null);
  if (settledInk.current === null) settledInk.current = new Set(inked);
  const settled = settledInk.current;
  useEffect(() => {
    for (const id of [...settled]) if (!inked.includes(id)) settled.delete(id);
  });

  const allFolderLabels = view.scale >= FOLDER_LABEL_SCALE;
  const searching = hits.size > 0;
  const at = (x: number, y: number) => toScreen(view, { x, y });
  const maxDepth = scene.pencil.reduce((m, s) => Math.max(m, s.depth), 0);
  const pending = usePresence(scene.linksPending && scene.dots.length > 0, CAPTION_EXIT_MS);

  return (
    <div className="cmap" ref={frameRef}>
      <svg
        ref={svgRef}
        className={`cmap-svg${dragging ? ' is-dragging' : ''}${writing ? ' is-writing' : ''}`}
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
        <g className="cmap-pencil">
          {scene.pencil.map((s) => (
            <path
              key={s.id}
              data-edge={s.id}
              d={curvePath(at(s.x1, s.y1), at(s.x2, s.y2), HIERARCHY_BEND)}
              strokeWidth={edgeWidth(s)}
              pathLength={1}
              style={writing ? { animationDelay: ms(s.depth * WRITE_STEP_MS) } : undefined}
            />
          ))}
        </g>
        <g className="cmap-links" style={writing ? { animationDelay: ms((maxDepth + 1) * WRITE_STEP_MS) } : undefined}>
          {scene.links.map((s) => (
            <path key={s.id} d={linkPath(at(s.x1, s.y1), at(s.x2, s.y2))} />
          ))}
        </g>
        <g className="cmap-ink">
          {/* Sorted, so a new stroke never moves an existing one in the DOM (a move would replay its draw). */}
          {[...inked].sort().map((id) => {
            const d = chainPath(
              scene.chains[id].map((p) => toScreen(view, p)),
              HIERARCHY_BEND,
            );
            return d ? <path key={id} data-ink={id} className={settled.has(id) ? undefined : 'ink-draw'} d={d} pathLength={1} /> : null;
          })}
        </g>
        <g className="cmap-folders">
          {scene.folders.map((f) => {
            const s = toScreen(view, f);
            const on = inkedFolders.has(f.id);
            const showLabel = allFolderLabels || on || f.id === focusId;
            return (
              <g
                key={f.id}
                ref={nodeRef(f.id)}
                className={`cmap-folder${on ? ' on' : ''}`}
                data-folder={f.id}
                transform={`translate(${f1(s.x)} ${f1(s.y)})`}
                style={writing ? { animationDelay: ms(f.depth * WRITE_STEP_MS + NODE_LAG_MS) } : undefined}
                role="button"
                aria-label={`folder ${f.name}, ${plural(f.noteCount, 'note')}`}
                {...nodeFocusProps(f.id)}
                onClick={(e) => onFolderClick(e, f.vaultId, f.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  fitTo(scene.folderBounds[f.id]);
                }}
                onKeyDown={(e) => {
                  if (activates(e)) onSelect({ kind: 'folder', vaultId: f.vaultId, id: f.id });
                }}
              >
                <circle className="cmap-hit" r={11} />
                {f.id === selFolder && <circle className="cmap-sel" r={10} />}
                <rect className="cmap-sq" x={-4.75} y={-4.75} width={9.5} height={9.5} rx={2.25} />
                <text className={`cmap-folder-label${showLabel ? '' : ' is-hidden'}`} x={0} y={19} textAnchor="middle" aria-hidden="true">
                  {f.name}
                </text>
              </g>
            );
          })}
        </g>
        <g className="cmap-hubs">
          {scene.hubs.map((h) => {
            const e = entryById.get(h.vaultId);
            if (!e) return null;
            const s = toScreen(view, h);
            return (
              <g
                key={h.vaultId}
                className="cmap-hub"
                transform={`translate(${f1(s.x)} ${f1(s.y)})`}
                onClick={(ev) => onHubClick(ev, h.vaultId)}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  fitTo(scene.vaultBounds[h.vaultId]);
                }}
                aria-hidden="true"
              >
                {h.vaultId === selHub && <circle className="cmap-sel" r={11} />}
                <g transform="translate(-7 -7)">
                  <VaultIcon color={e.vault.color} level={e.level} size={14} />
                </g>
                <text className="cmap-hub-name" x={0} y={-12} textAnchor="middle">
                  {e.vault.name}
                </text>
                {e.status === 'error' && (
                  <text className="cmap-hub-note" x={0} y={20} textAnchor="middle">
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
            const big = dot.id === selNote || dot.id === hot || active;
            const r = big ? 5 : 4;
            const when = relativeTime(dot.updatedAt, now);
            const showLabel = view.scale >= LABEL_SCALE || inkedNotes.has(dot.id) || active;
            const seen = firstSeen.current.get(dot.id);
            return (
              <g
                key={dot.id}
                ref={nodeRef(dot.id)}
                className={`cmap-node${searching && !inkedNotes.has(dot.id) ? ' is-faded' : ''}`}
                data-note={dot.id}
                transform={`translate(${f1(x)} ${f1(y)})`}
                style={writing ? { animationDelay: ms(dot.folderIds.length * WRITE_STEP_MS + NODE_LAG_MS) } : undefined}
                role="button"
                aria-label={`${dot.title}, ${dot.folderPath || 'vault root'}, edited ${when}`}
                {...nodeFocusProps(dot.id)}
                onClick={(e) => onDotClick(e, dot.vaultId, dot.id)}
                onKeyDown={(e) => {
                  if (activates(e)) navigate(noteHref(dot.vaultId, dot.id));
                }}
                onPointerEnter={() => setHover(dot.id)}
                onPointerLeave={() => setHover((h) => (h === dot.id ? null : h))}
              >
                <circle className="cmap-hit" r={12} />
                {/* Keyed by the edit time, so each new edit mounts a fresh pulse. */}
                {seen !== undefined && seen !== dot.updatedAt && <circle key={dot.updatedAt} className="cmap-pulse" r={r + 4} filter={`url(#${uid}-glow)`} />}
                {(tier === 'wet' || tier === 'fresh') && <circle className={`cmap-glow tier-${tier}`} r={r + 3} filter={`url(#${uid}-glow)`} />}
                <circle className={`cmap-dot tier-${tier}`} r={r} />
                {dot.id === selNote && <circle className="cmap-sel" r={r + 3} />}
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

      {pending.mounted && (
        <p ref={pending.ref} className="cmap-pending" data-state={pending.state}>
          Links appear once note text is decrypted.
        </p>
      )}
      {loading && scene.dots.length === 0 && <p className="cmap-msg">Decrypting your notes…</p>}
      {entries
        .filter((e) => e.status === 'error')
        .map((e) => (
          <p key={e.vaultId} className="sr-only">
            {e.vault.name}: couldn’t load
          </p>
        ))}
      <p id={`${uid}-help`} className="sr-only">
        Arrow keys move between folders and notes. Enter opens a note or selects a folder. Plus and minus zoom, 0 fits the map, Escape clears the
        selection.
      </p>
    </div>
  );
}
