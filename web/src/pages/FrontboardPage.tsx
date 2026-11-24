import { useState, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Logo } from '../brand/Logo';
import { useAppState } from '../state/StoreContext';

const sampleNotes = [
  { id: 'weather', label: 'Coastal weather', x: 578, y: 126, tier: 'dry', folder: 'ecology', excerpt: 'Wind turns east before the fog lifts. The best observations begin with a place and a date.' },
  { id: 'tidepools', label: 'Tide pools', x: 584, y: 254, tier: 'wet', folder: 'ecology', excerpt: 'At low tide, the basalt shelves hold a small world in place: anemones, limpets, and last night’s rain.' },
  { id: 'saltmarsh', label: 'Salt marsh', x: 572, y: 376, tier: 'fresh', folder: 'ecology', excerpt: 'A field note can sit beside the folder that gives it context, then connect to the ideas it touches.' },
  { id: 'fieldrecording', label: 'Field recording', x: 578, y: 486, tier: 'drying', folder: 'sound', excerpt: 'A note is still plain Markdown. Folders show where it lives; links reveal what it belongs with.' },
] as const;

type SampleId = (typeof sampleNotes)[number]['id'];
const folders = {
  ecology: { label: 'Ecology', x: 352, y: 246 },
  sound: { label: 'Sound', x: 352, y: 430 },
} as const;

function activateWithKey(event: KeyboardEvent<SVGGElement>, activate: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

function AtlasGraph({ selected, onSelect }: { selected: SampleId; onSelect: (id: SampleId) => void }) {
  const note = sampleNotes.find((entry) => entry.id === selected)!;
  return (
    <div className="atlas-plate">
      <svg className="atlas-svg" viewBox="0 0 800 570" role="group" aria-labelledby="atlas-title atlas-description">
        <title id="atlas-title">A sample vault, drawn as a concept map</title>
        <desc id="atlas-description">Field Notes branches into Ecology and Sound. Select a note to trace its folder path and read an excerpt.</desc>
        <defs>
          <pattern id="atlas-grid" width="32" height="32" patternUnits="userSpaceOnUse">
            <path d="M32 0H0V32" fill="none" stroke="var(--map-grid)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="800" height="570" fill="url(#atlas-grid)" />
        <ellipse className="atlas-wash" cx="455" cy="295" rx="290" ry="220" />
        <circle className="atlas-boundary" cx="418" cy="308" r="247" />

        <g className="atlas-edges" aria-hidden="true">
          <path className={note.folder === 'ecology' ? 'is-lit' : undefined} d="M145 296 C220 278 265 254 340 246" pathLength="1" />
          <path className={note.folder === 'sound' ? 'is-lit' : undefined} d="M145 306 C220 336 264 411 340 430" pathLength="1" />
          {sampleNotes.map((entry) => {
            const folder = folders[entry.folder];
            const selectedPath = entry.id === selected;
            return <path key={entry.id} className={selectedPath ? 'is-lit' : undefined} d={`M${folder.x + 8} ${folder.y} C440 ${folder.y}, 478 ${entry.y}, ${entry.x - 11} ${entry.y}`} pathLength="1" />;
          })}
          <path className="atlas-crosslink" d="M590 128 C710 174 710 432 590 484" />
          <path className="atlas-crosslink" d="M596 258 C670 274 670 350 584 374" />
        </g>

        <g className="atlas-hub" aria-hidden="true">
          <circle className="atlas-hub-aura" cx="128" cy="302" r="28" />
          <circle className="atlas-hub-ring" cx="128" cy="302" r="20" />
          <path className="atlas-hub-mark" d="M128 289l-7 12.5 7 13 7-13z" />
          <circle className="atlas-hub-core" cx="128" cy="302" r="2.2" />
          <text x="128" y="344" textAnchor="middle">Field Notes</text>
          <text className="atlas-subtitle" x="128" y="362" textAnchor="middle">VAULT</text>
        </g>

        <g className="atlas-folders" aria-hidden="true">
          {Object.entries(folders).map(([id, folder]) => (
            <g key={id} className={note.folder === id ? 'is-lit' : undefined} transform={`translate(${folder.x} ${folder.y})`}>
              <rect x="-7" y="-7" width="14" height="14" rx="3" />
              <text x="0" y="27" textAnchor="middle">{folder.label}</text>
            </g>
          ))}
        </g>

        <g className="atlas-notes">
          {sampleNotes.map((entry) => (
            <g
              key={entry.id}
              className={`atlas-note atlas-${entry.tier}${entry.id === selected ? ' is-selected' : ''}`}
              transform={`translate(${entry.x} ${entry.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Show ${entry.label}`}
              aria-pressed={entry.id === selected}
              onClick={() => onSelect(entry.id)}
              onKeyDown={(event) => activateWithKey(event, () => onSelect(entry.id))}
            >
              <circle className="atlas-hit" r="56" />
              <circle className="atlas-dot" r="5.5" />
              <circle className="atlas-ring" r="10" />
              <text x="18" y="4">{entry.label}</text>
            </g>
          ))}
        </g>
        <text className="atlas-scale" x="28" y="548">FOLDER STRUCTURE · WIKILINKS · RECENCY</text>
        <text className="atlas-scale atlas-coord" x="772" y="548" textAnchor="end">01 / 04</text>
      </svg>
      <div className="atlas-reading" aria-live="polite">
        <span className="atlas-reading-path">Field Notes <i>/</i> {folders[note.folder].label}</span>
        <p><strong>{note.label}</strong><span>{note.excerpt}</span></p>
        <span className={`atlas-tier-key ${note.tier}`} aria-label={`Recency: ${note.tier}`} />
      </div>
    </div>
  );
}

export function FrontboardPage() {
  const state = useAppState();
  const location = useLocation();
  const [selected, setSelected] = useState<SampleId>('tidepools');
  const nextPath = (location.state as { from?: string } | null)?.from;
  const authTo = state.phase === 'setup' ? '/setup' : '/login';
  const authState = state.phase === 'setup' ? undefined : { from: nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/' };

  return (
    <div className="frontboard">
      <header className="frontboard-nav">
        <Link className="frontboard-brand" to="/welcome" aria-label="Inked introduction">
          <Logo size={25} />
          <span>Inked</span>
        </Link>
        <nav aria-label="Introduction">
          <a href="#atlas">The map</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <Link className="frontboard-unlock" to={authTo} state={authState}>
          {state.phase === 'setup' ? 'Set up Inked' : 'Unlock your vault'}
          <span aria-hidden="true">↗</span>
        </Link>
      </header>

      <main>
        <section className="frontboard-hero" id="atlas">
          <div className="frontboard-copy">
            <h1>Knowledge<br />takes shape.</h1>
            <p className="frontboard-lede">Your notes already have a structure. Inked draws it into view, so you can follow an idea from its place in a folder to the notes it touches.</p>
            <div className="frontboard-actions">
              <Link className="frontboard-primary" to={authTo} state={authState}>
                {state.phase === 'setup' ? 'Create your vault' : 'Unlock Inked'}
                <span aria-hidden="true">↗</span>
              </Link>
              <a className="frontboard-secondary" href="#how-it-works">See how it works</a>
            </div>
            <p className="frontboard-notation"><span>FOLDERS</span><i>—</i><span>NOTES</span><i>—</i><span>LINKS</span></p>
          </div>
          <div className="frontboard-map-wrap">
            <div className="frontboard-map-head">
              <span>One vault, seen at a glance</span>
              <span className="frontboard-map-tag"><i /> INTERACTIVE SAMPLE</span>
            </div>
            <AtlasGraph selected={selected} onSelect={setSelected} />
          </div>
          <a className="frontboard-scroll" href="#how-it-works"><span />Scroll to explore</a>
        </section>

        <section className="frontboard-story" id="how-it-works">
          <div className="frontboard-story-lead">
            <h2>Structure, made visible.</h2>
            <p>Folders become branches. Notes become marks. Links become threads. The map is drawn from the way you already work.</p>
          </div>
          <div className="frontboard-story-lines">
            <article><h3>Place</h3><p>Folder paths turn into a map automatically. Nothing extra to tag or maintain.</p></article>
            <article><h3>Follow</h3><p>Open a note to see its neighbors, backlinks, and place in the larger vault.</p></article>
            <article><h3>Find</h3><p>Start with search, then follow the shape of an idea through your own notes.</p></article>
          </div>
        </section>

        <section className="frontboard-private" id="privacy">
          <div><h2>Your words stay yours.</h2><p>Inked encrypts notes in your browser before they reach the server. Plaintext stays on your device; your vault remains private while its structure stays useful to you.</p></div>
          <Link className="frontboard-primary" to={authTo} state={authState}>{state.phase === 'setup' ? 'Set up a private vault' : 'Unlock your vault'}<span aria-hidden="true">↗</span></Link>
        </section>
      </main>
      <footer className="frontboard-foot"><span>Inked</span><span>Plain Markdown. A map of what matters.</span></footer>
    </div>
  );
}
