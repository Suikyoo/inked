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
