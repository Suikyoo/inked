import {
  buildEntry,
  encryptFolderMeta,
  encryptNoteBody,
  encryptNoteMeta,
  INDEX_TITLE,
  indexBody,
  searchBodies,
  searchTitles,
  type SearchEntry,
} from 'inked-core';
import { ApiError, ToolError } from './errors';
import { toToolMessage } from './messages';
import type { Action, Policy } from './policy';
import { WriteLimiter } from './ratelimit';
import type { Session } from './session';
import type { FolderNode, NoteNode, VaultModel, VaultSnapshot } from './vault-model';

export interface NoteHeadOut {
  id: string;
  vaultId: string;
  path: string;
  title: string;
  updatedAt: string;
}
export interface NoteOut extends NoteHeadOut {
  body: string;
}
export interface TreeNoteOut {
  id: string;
  title: string;
  updatedAt: string;
  isIndex: boolean;
  broken?: boolean;
}
export interface TreeFolderOut {
  id: string;
  name: string;
  path: string;
  folders: TreeFolderOut[];
  notes: TreeNoteOut[];
}
export interface TreeOut {
  vault: { id: string; name: string };
  folders: TreeFolderOut[];
  notes: TreeNoteOut[];
}
export interface SearchOut {
  titleHits: { noteId: string; vaultId: string; path: string; title: string }[];
  bodyHits: { noteId: string; vaultId: string; path: string; title: string; snippet: string }[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);

/** Appends `text` on its own line: exactly one newline between the old body and the new text. */
export function appendJoin(body: string, text: string): string {
  if (body === '') return text;
  return (body.endsWith('\n') ? body : body + '\n') + text;
}

function cleanName(name: string, what: 'Folder name' | 'Title'): string {
  const n = name.trim();
  if (!n) throw new ToolError('invalid', `${what} must not be empty.`);
  if (what === 'Folder name' && n.includes('/')) throw new ToolError('invalid', 'Folder names must not contain "/".');
  return n;
}

const conflict = (now: string) =>
  new ToolError('conflict', `Note changed since you read it (now updatedAt ${now}). Re-read it before writing.`);

interface NoteWrite {
  encMeta?: string;
  encBody?: string;
  folderId?: string | null;
  base: string;
  title: string;
  folderIdAfter: string | null;
}

/** Domain operations. Each re-checks the policy, so a tool that forgot to cannot bypass it. */
export class Ops {
  readonly limiter: WriteLimiter;

  constructor(
    readonly session: Session,
    readonly model: VaultModel,
    readonly policy: Policy,
    limiter?: WriteLimiter,
  ) {
    this.limiter = limiter ?? new WriteLimiter(policy.writesPerMinute);
  }

  protected need(action: Action, vaultId?: string): void {
    if (!this.policy.actions.has(action)) throw new ToolError('denied', `Not permitted by the Inked MCP config: ${action}.`);
    // A disallowed vault is reported exactly like a missing one.
    if (vaultId !== undefined && !this.policy.vaultAllowed(vaultId)) throw new ToolError('not_found', 'Not found.');
  }

  protected head(snap: VaultSnapshot, n: { id: string; folderId: string | null; title: string; updatedAt: string }): NoteHeadOut {
    return { id: n.id, vaultId: snap.vault.id, path: this.model.pathOf(snap, n.folderId), title: n.title, updatedAt: n.updatedAt };
  }

  async listVaults() {
    this.need('vault.list');
    return (await this.model.listVaults()).map((v) => ({ id: v.id, name: v.name, color: v.color }));
  }

  async getTree(vaultRef: string): Promise<TreeOut> {
    this.need('tree.read');
    const snap = await this.model.snapshot((await this.model.vault(vaultRef)).id);
    const noteOut = (n: NoteNode): TreeNoteOut => ({
      id: n.id, title: n.title, updatedAt: n.updatedAt, isIndex: this.model.isIndex(snap, n), ...(n.broken ? { broken: true } : {}),
    });
    const notesIn = (folderId: string | null) =>
      [...snap.notes.values()].filter((n) => n.folderId === folderId).sort(byTitle).map(noteOut);
    const folderOut = (f: FolderNode): TreeFolderOut => ({
      id: f.id, name: f.name, path: f.path,
      folders: [...snap.folders.values()].filter((c) => c.parentId === f.id).sort(byName).map(folderOut),
      notes: notesIn(f.id),
    });
    return {
      vault: { id: snap.vault.id, name: snap.vault.name },
      folders: [...snap.folders.values()].filter((f) => f.parentId === null || !snap.folders.has(f.parentId)).sort(byName).map(folderOut),
      notes: notesIn(null),
    };
  }

  async readNote(noteId: string): Promise<NoteOut> {
    this.need('note.read');
    const { snap, note } = await this.model.locateNote(noteId);
    this.need('note.read', snap.vault.id);
    if (note.broken) throw new ToolError('invalid', 'Cannot decrypt this note.');
    const { body, updatedAt } = await this.model.readBody(snap, noteId);
    return { ...this.head(snap, { ...note, updatedAt }), body };
  }

  async search(query: string, vaultRef?: string, limit = 20): Promise<SearchOut> {
    this.need('search');
    const cap = Math.min(Math.max(1, Math.floor(limit)), 50);
    const vaults = vaultRef ? [await this.model.vault(vaultRef)] : await this.model.listVaults();
    const entries: SearchEntry[] = [];
    const bodies: Record<string, string> = {};
    const titleOf = new Map<string, { title: string; path: string; vaultId: string }>();
    for (const v of vaults) {
      const snap = await this.model.snapshot(v.id);
      Object.assign(bodies, await this.model.bodies(snap));
      for (const n of snap.notes.values()) {
        if (n.broken) continue;
        const segs = n.folderId ? (snap.folders.get(n.folderId)?.segments ?? []) : [];
        entries.push(buildEntry(n.id, v.id, v.name, segs, n.title, n.updatedAt));
        titleOf.set(n.id, { title: n.title, path: this.model.pathOf(snap, n.folderId), vaultId: v.id });
      }
    }
    const titleHits = query.trim() ? searchTitles(query, entries, cap) : [];
    const exclude = new Set(titleHits.map((h) => h.entry.noteId));
    const bodyHits = searchBodies(query, entries, bodies, exclude, cap);
    const meta = (id: string) => titleOf.get(id)!;
    return {
      titleHits: titleHits.map((h) => ({ noteId: h.entry.noteId, ...meta(h.entry.noteId) })),
      bodyHits: bodyHits.map((h) => ({
        noteId: h.entry.noteId,
        ...meta(h.entry.noteId),
        snippet: h.snippet.before + h.snippet.hit + h.snippet.after,
      })),
    };
  }

  private spend(n: number): void {
    if (!this.limiter.take(n)) {
      throw new ToolError('rate_limited', `Write limit reached (${this.policy.writesPerMinute} per minute). Try again shortly.`);
    }
  }

  private async putNote(snap: VaultSnapshot, folderId: string | null, title: string, body: string): Promise<NoteHeadOut> {
    const id = crypto.randomUUID();
    const vid = snap.vault.id;
    const { note } = await this.session.call(async () =>
      this.session.api.createNote(vid, {
        id,
        folderId,
        encMeta: await encryptNoteMeta(snap.key, vid, id, { title }),
        encBody: await encryptNoteBody(snap.key, vid, id, body),
      }),
    );
    return this.head(snap, { id, folderId, title, updatedAt: note.updatedAt });
  }

  async createFolder(vaultRef: string, parentRef: string | null, name: string) {
    this.need('folder.create');
    const clean = cleanName(name, 'Folder name');
    const snap = await this.model.snapshot((await this.model.vault(vaultRef)).id);
    this.need('folder.create', snap.vault.id);
    const parentId = this.model.resolveFolder(snap, parentRef);
    this.spend(2); // the folder and its Index note
    const id = crypto.randomUUID();
    const vid = snap.vault.id;
    await this.session.call(async () =>
      this.session.api.createFolder(vid, { id, parentId, encMeta: await encryptFolderMeta(snap.key, vid, id, { name: clean }) }),
    );
    const parentPath = this.model.pathOf(snap, parentId);
    const folder = { id, name: clean, path: parentPath ? `${parentPath}/${clean}` : clean, vaultId: vid };
    // Best effort, as in the web app: the folder exists even if its Index cannot be written.
    let indexNoteId: string | null = null;
    try {
      indexNoteId = (await this.putNote(snap, id, INDEX_TITLE, indexBody(clean))).id;
    } catch {
      indexNoteId = null;
    }
    return { folder, indexNoteId };
  }

  async createNote(vaultRef: string, folderRef: string | null, title: string, body: string): Promise<NoteHeadOut> {
    this.need('note.create');
    const clean = cleanName(title, 'Title');
    const snap = await this.model.snapshot((await this.model.vault(vaultRef)).id);
    this.need('note.create', snap.vault.id);
    const folderId = this.model.resolveFolder(snap, folderRef);
    this.spend(1);
    return this.putNote(snap, folderId, clean, body);
  }

  async createNotes(vaultRef: string, items: { folder: string | null; title: string; body: string }[]) {
    this.need('note.create');
    if (items.length < 1 || items.length > 50) throw new ToolError('invalid', 'create_notes takes 1 to 50 notes.');
    const snap = await this.model.snapshot((await this.model.vault(vaultRef)).id);
    this.need('note.create', snap.vault.id);
    // Validate everything before writing anything.
    const planned = items.map((it) => ({
      folderId: this.model.resolveFolder(snap, it.folder),
      title: cleanName(it.title, 'Title'),
      body: it.body,
    }));
    this.spend(planned.length);
    const created: NoteHeadOut[] = [];
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i];
      try {
        created.push(await this.putNote(snap, p.folderId, p.title, p.body));
      } catch (e) {
        return { created, failed: { index: i, error: toToolMessage(e) } };
      }
    }
    return { created, failed: null };
  }

  private async writeNote(
    noteId: string,
    action: Action,
    build: (snap: VaultSnapshot, note: NoteNode, body: string, updatedAt: string) => Promise<NoteWrite>,
  ): Promise<NoteHeadOut> {
    const { snap, note } = await this.model.locateNote(noteId);
    this.need(action, snap.vault.id);
    if (note.broken) throw new ToolError('invalid', 'Cannot decrypt this note.');
    const { body, updatedAt } = await this.model.readBody(snap, noteId);
    const w = await build(snap, note, body, updatedAt);
    try {
      const { note: head } = await this.session.call(() =>
        this.session.api.updateNote(noteId, { encMeta: w.encMeta, encBody: w.encBody, folderId: w.folderId, baseUpdatedAt: w.base }),
      );
      return this.head(snap, { id: noteId, folderId: w.folderIdAfter, title: w.title, updatedAt: head.updatedAt });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'conflict') {
        const fresh = await this.model.locateNote(noteId);
        throw conflict(fresh.note.updatedAt);
      }
      throw e;
    }
  }

  async appendToNote(noteId: string, text: string): Promise<NoteHeadOut> {
    this.need('note.append');
    this.spend(1);
    const attempt = () =>
      this.writeNote(noteId, 'note.append', async (snap, note, body, updatedAt) => ({
        encBody: await encryptNoteBody(snap.key, snap.vault.id, noteId, appendJoin(body, text)),
        base: updatedAt,
        title: note.title,
        folderIdAfter: note.folderId,
      }));
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof ToolError && e.kind === 'conflict') return attempt(); // one retry on a fresh read
      throw e;
    }
  }

  async updateNote(noteId: string, baseUpdatedAt: string, patch: { title?: string; body?: string }): Promise<NoteHeadOut> {
    this.need('note.update');
    if (patch.title === undefined && patch.body === undefined) throw new ToolError('invalid', 'Give a new title, a new body, or both.');
    const title = patch.title === undefined ? undefined : cleanName(patch.title, 'Title');
    this.spend(1);
    return this.writeNote(noteId, 'note.update', async (snap, note) => ({
      encMeta: title === undefined ? undefined : await encryptNoteMeta(snap.key, snap.vault.id, noteId, { title }),
      encBody: patch.body === undefined ? undefined : await encryptNoteBody(snap.key, snap.vault.id, noteId, patch.body),
      base: baseUpdatedAt,
      title: title ?? note.title,
      folderIdAfter: note.folderId,
    }));
  }

  async moveNote(noteId: string, folderRef: string | null): Promise<NoteHeadOut> {
    this.need('note.move');
    this.spend(1);
    return this.writeNote(noteId, 'note.move', async (snap, note, _body, updatedAt) => {
      const folderId = this.model.resolveFolder(snap, folderRef);
      return { folderId, base: updatedAt, title: note.title, folderIdAfter: folderId };
    });
  }

  async renameFolder(folderId: string, name: string) {
    this.need('folder.rename');
    const clean = cleanName(name, 'Folder name');
    const { snap, folder } = await this.model.locateFolder(folderId);
    this.need('folder.rename', snap.vault.id);
    this.spend(1);
    const vid = snap.vault.id;
    await this.session.call(async () =>
      this.session.api.updateFolder(folderId, { encMeta: await encryptFolderMeta(snap.key, vid, folderId, { name: clean }) }),
    );
    const parentPath = this.model.pathOf(snap, folder.parentId);
    return { id: folderId, name: clean, path: parentPath ? `${parentPath}/${clean}` : clean, vaultId: vid };
  }

  async moveFolder(folderId: string, newParentRef: string | null) {
    this.need('folder.move');
    const { snap, folder } = await this.model.locateFolder(folderId);
    this.need('folder.move', snap.vault.id);
    const parentId = this.model.resolveFolder(snap, newParentRef);
    for (let p: string | null = parentId; p; p = snap.folders.get(p)?.parentId ?? null) {
      if (p === folderId) throw new ToolError('invalid', 'A folder cannot move into itself or one of its subfolders.');
    }
    this.spend(1);
    await this.session.call(() => this.session.api.updateFolder(folderId, { parentId }));
    const parentPath = this.model.pathOf(snap, parentId);
    return { id: folderId, name: folder.name, path: parentPath ? `${parentPath}/${folder.name}` : folder.name, vaultId: snap.vault.id };
  }
}
