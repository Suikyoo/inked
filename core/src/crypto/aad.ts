/** Additional authenticated data strings, exactly as specified in docs/architecture.md. */
export const aad = {
  userKey: (userId: string) => `inked/userkey/${userId}`,
  userKeyRecovery: (userId: string) => `inked/userkey-recovery/${userId}`,
  vaultKey: (vaultId: string) => `inked/vaultkey/${vaultId}`,
  vaultMeta: (vaultId: string) => `inked/vault/${vaultId}`,
  folderMeta: (vaultId: string, folderId: string) => `inked/folder/${vaultId}/${folderId}`,
  noteMeta: (vaultId: string, noteId: string) => `inked/note-meta/${vaultId}/${noteId}`,
  noteBody: (vaultId: string, noteId: string) => `inked/note-body/${vaultId}/${noteId}`,
  noteVector: (vaultId: string, noteId: string, model: string) => `inked/note-vector/${vaultId}/${noteId}/${model}`,
} as const;

export const HKDF_INFO = {
  auth: 'inked/auth/v1',
  wrap: 'inked/wrap/v1',
  recoveryAuth: 'inked/recovery-auth/v1',
  recoveryWrap: 'inked/recovery-wrap/v1',
} as const;
