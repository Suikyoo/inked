import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { indexNoteOf } from 'inked-core';
import { prefs } from '../lib/prefs';
import { describeError } from '../lib/util';
import { folderPath, useStore } from '../state/StoreContext';
import type { FolderView, NoteView, TreeView, VaultView } from '../state/store';
import { ConfirmDialog, PromptDialog, SelectDialog } from './Dialog';
import { ChevronRight, IndexIcon, MoreIcon, PlusIcon } from './Icons';
import { Menu, type MenuItem } from './Menu';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

interface Children {
  folders: FolderView[];
  notes: NoteView[];
  /** The folder's Index note, which leads `notes`. */
  indexId?: string;
}

function indexChildren(tree: TreeView): Map<string | null, Children> {
  const map = new Map<string | null, Children>();
  const get = (k: string | null) => {
    let c = map.get(k);
    if (!c) map.set(k, (c = { folders: [], notes: [] }));
    return c;
  };
  for (const f of Object.values(tree.folders)) {
    // Orphans (parent missing) show at the root rather than vanishing.
    get(f.parentId && tree.folders[f.parentId] ? f.parentId : null).folders.push(f);
  }
  for (const n of Object.values(tree.notes)) get(n.folderId && tree.folders[n.folderId] ? n.folderId : null).notes.push(n);
  for (const [folderId, c] of map) {
    const indexId = indexNoteOf(tree, folderId)?.id;
    c.indexId = indexId;
    c.folders.sort((a, b) => collator.compare(a.name, b.name));
    // The folder's Index leads its notes.
    c.notes.sort((a, b) => Number(b.id === indexId) - Number(a.id === indexId) || collator.compare(a.title, b.title));
  }
  return map;
}

export function uniqueTitle(tree: TreeView | undefined, base = 'Untitled'): string {
  const taken = new Set(Object.values(tree?.notes ?? {}).map((n) => n.title.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

interface Flat {
  kind: 'folder' | 'note';
  id: string;
  parent: string | null;
  depth: number;
  expandable: boolean;
}

type DialogState =
  | { kind: 'none' }
  | { kind: 'newFolder'; parentId: string | null }
  | { kind: 'deleteFolder'; folder: FolderView; noteCount: number }
  | { kind: 'deleteNote'; note: NoteView }
  | { kind: 'moveNote'; note: NoteView }
  | { kind: 'moveFolder'; folder: FolderView };

export function VaultTree({
  vault,
  tree,
  activeNoteId,
  expanded,
  setExpanded,
  newFolderSignal,
}: {
  vault: VaultView;
  tree: TreeView | undefined;
  activeNoteId: string | null;
  expanded: Set<string>;
  setExpanded: (fn: (s: Set<string>) => Set<string>) => void;
  newFolderSignal: number;
}) {
  const store = useStore();
  const navigate = useNavigate();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [menuSignal, setMenuSignal] = useState<{ id: string; n: number }>({ id: '', n: 0 });
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLUListElement>(null);
  const lastFolderSignal = useRef(newFolderSignal);

  useEffect(() => {
    if (newFolderSignal !== lastFolderSignal.current) {
      lastFolderSignal.current = newFolderSignal;
      setDialog({ kind: 'newFolder', parentId: null });
    }
  }, [newFolderSignal]);

  const children = useMemo(() => (tree ? indexChildren(tree) : new Map<string | null, Children>()), [tree]);

  const flat = useMemo(() => {
    const out: Flat[] = [];
    const walk = (parent: string | null, depth: number) => {
      const c = children.get(parent);
      if (!c) return;
      for (const f of c.folders) {
        const kids = children.get(f.id);
        out.push({ kind: 'folder', id: f.id, parent, depth, expandable: !!kids && (kids.folders.length + kids.notes.length > 0) });
        if (expanded.has(f.id)) walk(f.id, depth + 1);
      }
      for (const n of c.notes) out.push({ kind: 'note', id: n.id, parent, depth, expandable: false });
    };
    walk(null, 0);
    return out;
  }, [children, expanded]);

  // Expand the folders containing the open note.
  useEffect(() => {
    if (!activeNoteId || !tree?.notes[activeNoteId]) return;
    const ancestors = folderPath(tree, tree.notes[activeNoteId].folderId).map((f) => f.id);
    if (ancestors.some((a) => !expanded.has(a))) {
      setExpanded((s) => new Set([...s, ...ancestors]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId, tree]);

  const tabbable = flat.some((f) => f.id === focusId) ? focusId : (activeNoteId && flat.some((f) => f.id === activeNoteId) ? activeNoteId : flat[0]?.id);

  // Focus is moved after the render that makes the row exist (e.g. after expanding a folder).
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (focusRequest) rootRef.current?.querySelector<HTMLElement>(`[data-id="${focusRequest.id}"]`)?.focus();
  }, [focusRequest]);

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    setFocusRequest((r) => ({ id, n: (r?.n ?? 0) + 1 }));
  };

  const toggle = (id: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      const want = open ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });

  // User-initiated expand/collapse. Expanding a folder opens its Index, unless the open note is
  // already inside it (so browsing within a folder never yanks you back to the Index).
  const toggleFolder = (id: string, open?: boolean) => {
    const want = open ?? !expanded.has(id);
    toggle(id, want);
    if (!want || expanded.has(id) || !tree) return;
    const index = indexNoteOf(tree, id);
    if (!index) return;
    const active = activeNoteId ? tree.notes[activeNoteId] : undefined;
    if (active && folderPath(tree, active.folderId).some((f) => f.id === id)) return;
    navigate(`/v/${vault.id}/n/${index.id}`);
  };

  const openNote = (id: string) => navigate(`/v/${vault.id}/n/${id}`);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const newNote = (folderId: string | null) =>
    run(async () => {
      const head = await store.createNote(vault.id, folderId, uniqueTitle(tree));
      if (folderId) toggle(folderId, true);
      navigate(`/v/${vault.id}/n/${head.id}`, { state: { fresh: true } });
    });

  const subtreeNoteCount = (folderId: string) => {
    let count = 0;
    const walk = (id: string) => {
      const c = children.get(id);
      if (!c) return;
      count += c.notes.length;
      c.folders.forEach((f) => walk(f.id));
    };
    walk(folderId);
    return count;
  };

  const folderOptions = (exclude?: string) => {
    const banned = new Set<string>();
    if (exclude) {
      const walk = (id: string) => {
        banned.add(id);
        children.get(id)?.folders.forEach((f) => walk(f.id));
      };
      walk(exclude);
    }
    const opts = [{ value: '', label: 'Vault root (no folder)' }];
    const all = Object.values(tree?.folders ?? {})
      .filter((f) => !banned.has(f.id))
      .map((f) => ({ value: f.id, label: folderPath(tree, f.id).map((p) => p.name).join(' / ') }))
      .sort((a, b) => collator.compare(a.label, b.label));
    return opts.concat(all);
  };

  const itemsFor = (item: Flat): MenuItem[] => {
    if (item.kind === 'folder') {
      const folder = tree!.folders[item.id];
      return [
        { label: 'New note here', onSelect: () => void newNote(folder.id) },
        { label: 'New folder inside', onSelect: () => setDialog({ kind: 'newFolder', parentId: folder.id }) },
        { label: 'Rename', onSelect: () => setRenaming(folder.id) },
        { label: 'Move to…', onSelect: () => setDialog({ kind: 'moveFolder', folder }) },
        {
          label: 'Delete folder',
          danger: true,
          onSelect: () => setDialog({ kind: 'deleteFolder', folder, noteCount: subtreeNoteCount(folder.id) }),
        },
      ];
    }
    const note = tree!.notes[item.id];
    return [
      { label: 'Open', onSelect: () => openNote(note.id) },
      { label: 'Rename', onSelect: () => setRenaming(note.id) },
      { label: 'Move to folder…', onSelect: () => setDialog({ kind: 'moveNote', note }) },
      { label: 'Delete note', danger: true, onSelect: () => setDialog({ kind: 'deleteNote', note }) },
    ];
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    const id = target.closest<HTMLElement>('[data-id]')?.dataset.id;
    const i = flat.findIndex((f) => f.id === id);
    if (i < 0) return;
    const item = flat[i];
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'ArrowDown':
        handled();
        focusRow(flat[i + 1]?.id);
        break;
      case 'ArrowUp':
        handled();
        focusRow(flat[i - 1]?.id);
        break;
      case 'Home':
        handled();
        focusRow(flat[0]?.id);
        break;
      case 'End':
        handled();
        focusRow(flat[flat.length - 1]?.id);
        break;
      case 'ArrowRight':
        handled();
        if (item.kind === 'folder' && item.expandable) {
          if (!expanded.has(item.id)) toggleFolder(item.id, true);
          else focusRow(flat[i + 1]?.id);
        }
        break;
      case 'ArrowLeft':
        handled();
        if (item.kind === 'folder' && expanded.has(item.id)) toggle(item.id, false);
        else if (item.parent) focusRow(item.parent);
        break;
      case 'Enter':
      case ' ':
        handled();
        if (item.kind === 'folder') toggleFolder(item.id);
        else openNote(item.id);
        break;
      case 'F2':
        handled();
        setRenaming(item.id);
        break;
      case 'Delete':
        handled();
        if (item.kind === 'folder') {
          setDialog({ kind: 'deleteFolder', folder: tree!.folders[item.id], noteCount: subtreeNoteCount(item.id) });
        } else setDialog({ kind: 'deleteNote', note: tree!.notes[item.id] });
        break;
      case 'ContextMenu':
        handled();
        setMenuSignal((m) => ({ id: item.id, n: m.n + 1 }));
        break;
      default:
        if (e.key === 'F10' && e.shiftKey) {
          handled();
          setMenuSignal((m) => ({ id: item.id, n: m.n + 1 }));
        }
    }
  };

  if (!tree) return <p className="tree-empty">Decrypting…</p>;
  if (tree.status === 'loading' && flat.length === 0) return <p className="tree-empty">Decrypting…</p>;
  if (tree.status === 'error') {
    return (
      <p className="tree-empty">
        Couldn’t load this vault.{' '}
        <button type="button" className="linkish" onClick={() => void store.loadTree(vault.id).catch(() => undefined)}>
          Try again
        </button>
      </p>
    );
  }

  const renderLevel = (parent: string | null, depth: number) => {
    const c = children.get(parent);
    if (!c) return null;
    return (
      <>
        {c.folders.map((f) => {
          const isOpen = expanded.has(f.id);
          const kids = children.get(f.id);
          const hasKids = !!kids && kids.folders.length + kids.notes.length > 0;
          return (
            <li
              key={f.id}
              role="treeitem"
              aria-expanded={hasKids ? isOpen : undefined}
              aria-level={depth + 1}
              aria-label={f.name}
              data-id={f.id}
              tabIndex={tabbable === f.id ? 0 : -1}
              onFocus={(e) => e.target === e.currentTarget && setFocusId(f.id)}
              className="tree-li"
            >
              <div
                className="tree-row"
                onClick={() => {
                  toggleFolder(f.id);
                  focusRow(f.id);
                }}
              >
                <span className={isOpen ? 'tree-chev is-open' : 'tree-chev'} aria-hidden="true">
                  {hasKids ? <ChevronRight size={10} /> : null}
                </span>
                {renaming === f.id ? (
                  <RenameInput
                    initial={f.name}
                    label="Folder name"
                    onDone={async (name) => {
                      setRenaming(null);
                      if (name && name !== f.name) await run(() => store.renameFolder(vault.id, f.id, name));
                      focusRow(f.id);
                    }}
                  />
                ) : (
                  <span className={f.broken ? 'tree-label is-broken' : 'tree-label'}>{f.name}</span>
                )}
                <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="ibtn ibtn-sm"
                    tabIndex={-1}
                    aria-label={`New note in ${f.name}`}
                    title="New note here"
                    onClick={() => void newNote(f.id)}
                  >
                    <PlusIcon size={11} />
                  </button>
                  <Menu
                    label={`Actions for folder ${f.name}`}
                    items={itemsFor({ kind: 'folder', id: f.id, parent, depth, expandable: hasKids })}
                    className="ibtn ibtn-sm"
                    tabIndex={-1}
                    openSignal={menuSignal.id === f.id ? menuSignal.n : undefined}
                  >
                    <MoreIcon size={12} />
                  </Menu>
                </span>
              </div>
              {hasKids && (
                // Stays mounted so collapse can animate; closed rows are visibility:hidden (see shell.css).
                <div className="tree-collapse" data-open={isOpen}>
                  <div className="tree-collapse-inner">
                    <ul role="group" className="tree-group">
                      {renderLevel(f.id, depth + 1)}
                    </ul>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {c.notes.map((n) => {
          const active = n.id === activeNoteId;
          const isIndex = n.id === c.indexId;
          return (
            <li
              key={n.id}
              role="treeitem"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              aria-level={depth + 1}
              aria-label={n.title}
              data-id={n.id}
              tabIndex={tabbable === n.id ? 0 : -1}
              onFocus={(e) => e.target === e.currentTarget && setFocusId(n.id)}
              className="tree-li"
            >
              <div className={`tree-row${active ? ' is-active' : ''}${isIndex ? ' tree-index' : ''}`} onClick={() => openNote(n.id)}>
                <span className="tree-chev" aria-hidden="true">
                  {isIndex && <IndexIcon />}
                </span>
                {renaming === n.id ? (
                  <RenameInput
                    initial={n.title}
                    label="Note title"
                    onDone={async (title) => {
                      setRenaming(null);
                      if (title && title !== n.title) await run(() => store.renameNote(vault.id, n.id, title));
                      focusRow(n.id);
                    }}
                  />
                ) : (
                  <span className={n.broken ? 'tree-label is-broken' : 'tree-label'}>{n.title || 'Untitled'}</span>
                )}
                <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
                  <Menu
                    label={`Actions for note ${n.title}`}
                    items={itemsFor({ kind: 'note', id: n.id, parent, depth, expandable: false })}
                    className="ibtn ibtn-sm"
                    tabIndex={-1}
                    openSignal={menuSignal.id === n.id ? menuSignal.n : undefined}
                  >
                    <MoreIcon size={12} />
                  </Menu>
                </span>
              </div>
            </li>
          );
        })}
      </>
    );
  };

  const empty = flat.length === 0;

  return (
    <>
      {empty ? (
        <div className="tree-empty">
          No notes yet.{' '}
          <button type="button" className="linkish" onClick={() => void newNote(null)}>
            Write the first one
          </button>
        </div>
      ) : (
        <ul ref={rootRef} role="tree" aria-label={`${vault.name} vault`} className="tree" onKeyDown={onKeyDown}>
          {renderLevel(null, 0)}
        </ul>
      )}
      {error && (
        <p className="tree-error" role="alert">
          {error}
        </p>
      )}

      <PromptDialog
        open={dialog.kind === 'newFolder'}
        title="New folder"
        label="Folder name"
        submitLabel="Create folder"
        onClose={() => setDialog({ kind: 'none' })}
        onSubmit={async (name) => {
          if (dialog.kind !== 'newFolder') return;
          try {
            const f = await store.createFolder(vault.id, dialog.parentId, name);
            if (dialog.parentId) toggle(dialog.parentId, true);
            const created = store.getState().trees[vault.id];
            const index = created && indexNoteOf(created, f.id);
            if (index) {
              toggle(f.id, true);
              navigate(`/v/${vault.id}/n/${index.id}`, { state: { mode: 'edit' } });
            } else focusRow(f.id);
          } catch (e) {
            throw new Error(describeError(e));
          }
        }}
      />
      <ConfirmDialog
        open={dialog.kind === 'deleteFolder'}
        title="Delete folder?"
        message={
          dialog.kind === 'deleteFolder' && (
            <p>
              “{dialog.folder.name}” and everything inside it
              {dialog.noteCount > 0 ? ` (${dialog.noteCount} ${dialog.noteCount === 1 ? 'note' : 'notes'})` : ''} will be
              deleted. This can’t be undone.
            </p>
          )
        }
        confirmLabel="Delete folder"
        onClose={() => setDialog({ kind: 'none' })}
        onConfirm={async () => {
          if (dialog.kind !== 'deleteFolder') return;
          const insideActive =
            activeNoteId && folderPath(tree, tree.notes[activeNoteId]?.folderId ?? null).some((f) => f.id === dialog.folder.id);
          try {
            await store.deleteFolder(vault.id, dialog.folder.id);
          } catch (e) {
            throw new Error(describeError(e));
          }
          if (insideActive) navigate(`/v/${vault.id}`);
        }}
      />
      <ConfirmDialog
        open={dialog.kind === 'deleteNote'}
        title="Delete note?"
        message={dialog.kind === 'deleteNote' && <p>“{dialog.note.title}” will be deleted. This can’t be undone.</p>}
        confirmLabel="Delete note"
        onClose={() => setDialog({ kind: 'none' })}
        onConfirm={async () => {
          if (dialog.kind !== 'deleteNote') return;
          try {
            await store.deleteNote(vault.id, dialog.note.id);
          } catch (e) {
            throw new Error(describeError(e));
          }
          if (dialog.note.id === activeNoteId) navigate(`/v/${vault.id}`);
        }}
      />
      <SelectDialog
        open={dialog.kind === 'moveNote'}
        title={dialog.kind === 'moveNote' ? `Move “${dialog.note.title}”` : 'Move note'}
        label="Folder"
        options={folderOptions()}
        initial={dialog.kind === 'moveNote' ? (dialog.note.folderId ?? '') : ''}
        onClose={() => setDialog({ kind: 'none' })}
        onSubmit={async (value) => {
          if (dialog.kind !== 'moveNote') return;
          const target = value || null;
          if (target === dialog.note.folderId) return;
          try {
            await store.moveNote(vault.id, dialog.note.id, target);
          } catch (e) {
            throw new Error(describeError(e));
          }
          if (target) toggle(target, true);
        }}
      />
      <SelectDialog
        open={dialog.kind === 'moveFolder'}
        title={dialog.kind === 'moveFolder' ? `Move “${dialog.folder.name}”` : 'Move folder'}
        label="Into"
        options={dialog.kind === 'moveFolder' ? folderOptions(dialog.folder.id) : []}
        initial={dialog.kind === 'moveFolder' ? (dialog.folder.parentId ?? '') : ''}
        onClose={() => setDialog({ kind: 'none' })}
        onSubmit={async (value) => {
          if (dialog.kind !== 'moveFolder') return;
          const target = value || null;
          if (target === dialog.folder.parentId) return;
          try {
            await store.moveFolder(vault.id, dialog.folder.id, target);
          } catch (e) {
            throw new Error(describeError(e));
          }
          if (target) toggle(target, true);
        }}
      />
    </>
  );
}

function RenameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="tree-rename"
      aria-label={label}
      value={value}
      autoFocus
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value.trim() || null);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value.trim() || null)}
      spellCheck={prefs.spellcheck()}
      maxLength={200}
    />
  );
}
