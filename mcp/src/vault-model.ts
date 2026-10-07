import { decryptFolderMeta, decryptNoteBody, decryptNoteMeta, decryptVaultMeta, indexNoteOf, type VaultDTO } from 'inked-core';
import { ToolError } from './errors';
import type { Policy } from './policy';
import type { Session } from './session';

export interface VaultInfo {
  id: string;
  name: string;
  color: string;
  broken?: boolean;
  dto: VaultDTO;
}
export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  /** Names from the root joined with "/". A name that itself contains "/" is shown raw. */
  path: string;
  segments: string[];
  broken?: boolean;
}
export interface NoteNode {
  id: string;
  folderId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  broken?: boolean;
}
export interface VaultSnapshot {
  vault: VaultInfo;
  key: CryptoKey;
  folders: Map<string, FolderNode>;
  notes: Map<string, NoteNode>;
}

async function openVault(session: Session, dto: VaultDTO): Promise<VaultInfo> {
  try {
    const key = await session.vaultKey(dto);
    const meta = await decryptVaultMeta(key, dto.id, dto.encMeta);
    return { id: dto.id, name: meta.name, color: meta.color, dto };
  } catch {
    return { id: dto.id, name: 'Unreadable vault', color: '#524B6E', broken: true, dto };
  }
}

/** Every vault of the account, decrypted. Used once at start to resolve the policy's vault names. */
export async function listAllVaults(session: Session): Promise<VaultInfo[]> {
  const { vaults } = await session.call(() => session.api.listVaults());
  return Promise.all(vaults.map((v) => openVault(session, v)));
}

const notFound = (what: string) => new ToolError('not_found', `${what} not found.`);

/** Decrypted, policy-filtered view of the account. Every call refetches, so browser edits show up. */
export class VaultModel {
  private readonly bodyCache = new Map<string, string>(); // `${noteId}@${updatedAt}` → body
  private readonly noteVault = new Map<string, string>(); // noteId → vaultId, a hint for locateNote

  constructor(
    private readonly session: Session,
    private readonly policy: Policy,
  ) {}

  async listVaults(): Promise<VaultInfo[]> {
    return (await listAllVaults(this.session)).filter((v) => this.policy.vaultAllowed(v.id) && !v.broken);
  }

  async vault(ref: string): Promise<VaultInfo> {
    const all = await this.listVaults();
    const byId = all.find((v) => v.id === ref);
    if (byId) return byId;
    const named = all.filter((v) => v.name === ref);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      throw new ToolError('ambiguous', `Vault name "${ref}" is ambiguous; use an id: ${named.map((v) => v.id).join(', ')}`);
    }
    throw notFound('Vault');
  }

  async snapshot(vaultId: string): Promise<VaultSnapshot> {
    const vault = await this.vault(vaultId);
    const key = await this.session.vaultKey(vault.dto);
    const tree = await this.session.call(() => this.session.api.tree(vault.id));

    const raw = new Map<string, { id: string; name: string; parentId: string | null; broken?: boolean }>();
    for (const f of tree.folders) {
      try {
        const meta = await decryptFolderMeta(key, vault.id, f.id, f.encMeta);
        raw.set(f.id, { id: f.id, name: meta.name, parentId: f.parentId });
      } catch {
        raw.set(f.id, { id: f.id, name: 'Unreadable folder', parentId: f.parentId, broken: true });
      }
    }
    const folders = new Map<string, FolderNode>();
    for (const f of raw.values()) {
      const segments: string[] = [];
      const seen = new Set<string>();
      for (let cur: string | null = f.id; cur && raw.has(cur) && !seen.has(cur); cur = raw.get(cur)!.parentId) {
        seen.add(cur); // a corrupt cycle stops here instead of looping
        segments.unshift(raw.get(cur)!.name);
      }
      folders.set(f.id, { ...f, segments, path: segments.join('/') });
    }

    const notes = new Map<string, NoteNode>();
    for (const n of tree.notes) {
      const base = { id: n.id, folderId: n.folderId, createdAt: n.createdAt, updatedAt: n.updatedAt, size: n.size };
      try {
        notes.set(n.id, { ...base, title: (await decryptNoteMeta(key, vault.id, n.id, n.encMeta)).title });
      } catch {
        notes.set(n.id, { ...base, title: 'Unreadable note', broken: true });
      }
      this.noteVault.set(n.id, vault.id);
    }
    return { vault, key, folders, notes };
  }

  /** `null`/"" = vault root; an id; or a path of exact names separated by "/". Never guesses. */
  resolveFolder(snap: VaultSnapshot, ref: string | null | undefined): string | null {
    if (ref === null || ref === undefined || ref.trim() === '') return null;
    if (snap.folders.has(ref)) return ref;
    const parts = ref.split('/').map((s) => s.trim()).filter(Boolean);
    let parent: string | null = null;
    for (const part of parts) {
      const kids = [...snap.folders.values()].filter((f) => f.parentId === parent && f.name === part && !f.broken);
      if (kids.length === 0) throw notFound(`Folder "${ref}"`);
      if (kids.length > 1) {
        throw new ToolError('ambiguous', `Folder path "${ref}" is ambiguous at "${part}"; use an id: ${kids.map((f) => f.id).join(', ')}`);
      }
      parent = kids[0].id;
    }
    return parent;
  }

  pathOf(snap: VaultSnapshot, folderId: string | null): string {
    return folderId ? (snap.folders.get(folderId)?.path ?? '') : '';
  }

  private async allowedVaultIdsHintFirst(hint?: string): Promise<string[]> {
    const ids = (await this.listVaults()).map((v) => v.id);
    return hint && ids.includes(hint) ? [hint, ...ids.filter((i) => i !== hint)] : ids;
  }

  async locateNote(noteId: string): Promise<{ snap: VaultSnapshot; note: NoteNode }> {
    for (const vid of await this.allowedVaultIdsHintFirst(this.noteVault.get(noteId))) {
      const snap = await this.snapshot(vid);
      const note = snap.notes.get(noteId);
      if (note) return { snap, note };
    }
    throw notFound('Note');
  }

  async locateFolder(folderId: string): Promise<{ snap: VaultSnapshot; folder: FolderNode }> {
    for (const vid of await this.allowedVaultIdsHintFirst()) {
      const snap = await this.snapshot(vid);
      const folder = snap.folders.get(folderId);
      if (folder) return { snap, folder };
    }
    throw notFound('Folder');
  }

  async readBody(snap: VaultSnapshot, noteId: string): Promise<{ body: string; updatedAt: string }> {
    const { note } = await this.session.call(() => this.session.api.getNote(noteId));
    const cacheKey = `${noteId}@${note.updatedAt}`;
    let body = this.bodyCache.get(cacheKey);
    if (body === undefined) {
      try {
        body = await decryptNoteBody(snap.key, snap.vault.id, noteId, note.encBody);
      } catch {
        throw new ToolError('invalid', 'Cannot decrypt this note.');
      }
      this.bodyCache.set(cacheKey, body);
    }
    return { body, updatedAt: note.updatedAt };
  }

  /** Decrypted bodies of every readable note in the vault (broken ones are left out). */
  async bodies(snap: VaultSnapshot): Promise<Record<string, string>> {
    const { notes } = await this.session.call(() => this.session.api.bodies(snap.vault.id));
    const out: Record<string, string> = {};
    for (const n of notes) {
      const cacheKey = `${n.id}@${n.updatedAt}`;
      let body = this.bodyCache.get(cacheKey);
      if (body === undefined) {
        try {
          body = await decryptNoteBody(snap.key, snap.vault.id, n.id, n.encBody);
        } catch {
          continue;
        }
        this.bodyCache.set(cacheKey, body);
      }
      out[n.id] = body;
    }
    return out;
  }

  isIndex(snap: VaultSnapshot, note: NoteNode): boolean {
    return indexNoteOf({ notes: Object.fromEntries(snap.notes) }, note.folderId)?.id === note.id;
  }
}
