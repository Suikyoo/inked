import { buildEntry, searchBodies, searchTitles, type SearchEntry } from 'inked-core';
import { ToolError } from './errors';
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
}
