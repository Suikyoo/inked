import type { Pt } from './layout';
import type { Scene } from './scene';

const shift = (p: Pt, o: Pt | undefined): Pt => (o ? { x: p.x + o.x, y: p.y + o.y } : p);

/**
 * The scene with some dots and folders moved by `off` (id -> offset). Edges, links and ink chains follow their
 * ends. Everything not touched is shared with `scene`, so a few moving nodes cost little.
 */
export function displaceScene(scene: Scene, off: ReadonlyMap<string, Pt>): Scene {
  if (off.size === 0) return scene;
  const dotIds = new Set(scene.dots.map((d) => d.id));
  const chains = { ...scene.chains };
  for (const [id, chain] of Object.entries(scene.chains)) {
    const folders = scene.chainFolders[id] ?? [];
    const isDot = dotIds.has(id);
    if (!folders.some((f) => off.has(f)) && !(isDot && off.has(id))) continue;
    chains[id] = chain.map((p, i) => {
      if (i === 0) return p;
      if (i <= folders.length) return shift(p, off.get(folders[i - 1]));
      return isDot ? shift(p, off.get(id)) : p;
    });
  }
  const move = <T extends { x1: number; y1: number; x2: number; y2: number }>(s: T, a: Pt | undefined, b: Pt | undefined): T =>
    a || b ? { ...s, x1: s.x1 + (a?.x ?? 0), y1: s.y1 + (a?.y ?? 0), x2: s.x2 + (b?.x ?? 0), y2: s.y2 + (b?.y ?? 0) } : s;
  return {
    ...scene,
    dots: scene.dots.map((d) => (off.has(d.id) ? { ...d, ...shift(d, off.get(d.id)) } : d)),
    folders: scene.folders.map((f) => (off.has(f.id) ? { ...f, ...shift(f, off.get(f.id)) } : f)),
    pencil: scene.pencil.map((s) => move(s, s.from === null ? undefined : off.get(s.from), off.get(s.id))),
    links: scene.links.map((l) => move(l, off.get(l.a), off.get(l.b))),
    chains,
  };
}
