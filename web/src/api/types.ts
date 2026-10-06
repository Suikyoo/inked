import type { KdfParams } from '../crypto';

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface VaultDTO {
  id: string;
  encMeta: string;
  wrappedKey: string;
  createdAt: string;
  updatedAt: string;
  noteCount: number;
  activeNoteCount7d: number;
}

export interface FolderDTO {
  id: string;
  parentId: string | null;
  encMeta: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteHeadDTO {
  id: string;
  folderId: string | null;
  encMeta: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDTO extends NoteHeadDTO {
  encBody: string;
}

export interface RegisterBody {
  inviteToken?: string;
  userId: string;
  username: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  authKey: string;
  wrappedUserKey: string;
  recoveryAuth: string;
  wrappedUserKeyRecovery: string;
}

/** First-admin setup: the token is printed in the server log on first start. */
export type SetupBody = Omit<RegisterBody, 'inviteToken'> & { setupToken: string };

export interface InviteDTO {
  id: string;
  createdAt: string;
  expiresAt: string;
  usedBy?: string | null;
  usedAt?: string | null;
}
