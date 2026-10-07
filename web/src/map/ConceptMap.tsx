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
/** Below this zoom, folder labels crowd the dots, so only those on an inked path are drawn. */
const FOLDER_LABEL_SCALE = 0.9;
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

  /** Pans a dot that lies outside the view to the centre. Asking twice for the same dot is harmless. */
  const revealDot = (id: string) => {
    const d = dotById.get(id);
    if (!d) return;
    const s = toScreen(view, d);
    if (s.x < EDGE || s.y < EDGE || s.x > size.w - EDGE || s.y > size.h - EDGE) {
      touched.current = true;
      animateTo(panBy(view, size.w / 2 - s.x, size.h / 2 - s.y));
    }
  };
  const focusDot = (id: string) => {
    setFocusId(id);
    revealDot(id);
    dotRefs.current.get(id)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const dir = arrowDir(e.key);
    // Ctrl/Meta/Alt with + - 0 is browser zoom and Alt+Arrow is browser history; leave them alone.
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (dir && plain) {
      e.preventDefault();
      const from = shown.find((s) => s.dot.id === rovingId);
      if (!from) return;
      const next = nearestInDirection(
        from,
        shown.map((s) => ({ id: s.dot.id, x: s.x, y: s.y })),
        dir,
      );
      if (next) focusDot(next);
    } else if (plain && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      zoomBy(STEP);
    } else if (plain && e.key === '-') {
      e.preventDefault();
      zoomBy(1 / STEP);
    } else if (plain && e.key === '0') {
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
  const inkedFolders = new Set<string>();
  for (const id of inked) for (const fid of dotById.get(id)!.folderIds) inkedFolders.add(fid);
  const allFolderLabels = view.scale >= FOLDER_LABEL_SCALE;
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
        <g className="cmap-folders" aria-hidden="true">
          {scene.folders.map((f) => {
            if (!allFolderLabels && !inkedFolders.has(f.id)) return null;
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
                onFocus={() => {
                  setFocusId(dot.id);
                  revealDot(dot.id);
                }}
                onBlur={(e) => {
                  const next = e.relatedTarget;
                  if (!(next instanceof Element && next.closest('g.cmap-node') && svgRef.current?.contains(next))) setFocusId(null);
                }}
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
      {entries
        .filter((e) => e.status === 'error')
        .map((e) => (
          <p key={e.vaultId} className="sr-only">
            {e.vault.name}: couldn’t load
          </p>
        ))}
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
