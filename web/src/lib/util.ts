import { isApiError } from '../api/client';
import { isCryptoError } from '../crypto';

export const VAULT_COLORS = ['#45A89E', '#D19C3C', '#6F95D6', '#D9768F'] as const;

export function nextVaultColor(used: string[]): string {
  const counts = VAULT_COLORS.map((c) => used.filter((u) => u.toUpperCase() === c).length);
  const min = Math.min(...counts);
  return VAULT_COLORS[counts.indexOf(min)];
}

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
export const MIN_PASSWORD = 10;

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
  return formatDate(iso);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function wordCount(s: string): number {
  const m = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return m ? m.length : 0;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (e.g. plain http on a LAN).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export const NOTE_TOO_LARGE_MESSAGE = 'This note is too large to save (about 1.5 MB of text is the limit).';

/** Plain-language message for anything thrown by the API client or crypto code. */
/**
 * Why a recovery-key replacement failed. A 4xx means the server refused it, so the old key still
 * works; a network error or 5xx leaves the outcome unknown, and then either key may be the live one.
 */
export const ROTATION_NOT_SAVED = 'Not saved — your old recovery key still works.';

export function rotationCommitError(e: unknown): string {
  if (isApiError(e) && e.status >= 400 && e.status < 500) return ROTATION_NOT_SAVED;
  return 'We couldn’t confirm the change. Keep BOTH your old and new recovery keys; one of them works. Try again from Settings to be sure.';
}

export function describeError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (e instanceof Error && e.name === 'NoteTooLargeError') return e.message;
  if (isApiError(e)) {
    switch (e.code) {
      case 'network':
        return e.message;
      case 'locked':
        return 'Too many tries. Wait a minute and try again.';
      case 'invalid_credentials':
        return 'Wrong username or password.';
      case 'unauthorized':
        return 'Your session ended. Sign in again.';
      case 'username_taken':
        return 'That username is taken. Pick another.';
      case 'invalid_invite':
        return 'This invite link is no longer valid. Ask for a new one.';
      case 'invalid_setup_token':
        return 'That setup token doesn’t match. Copy it again from the server log.';
      case 'already_setup':
        return 'Inked is already set up. Sign in instead.';
      case 'too_large':
        return NOTE_TOO_LARGE_MESSAGE;
      case 'conflict':
        return 'This note changed somewhere else.';
      case 'cycle':
        return 'A folder can’t be moved inside itself.';
      case 'forbidden':
        return 'You don’t have permission to do that.';
      case 'csrf':
        return 'The request was blocked. Reload the page and try again.';
    }
    if (e.status === 404) return 'That item no longer exists.';
    if (e.status >= 500) return 'The server had a problem. Try again in a moment.';
    return e.message && e.message !== e.code ? e.message : fallback;
  }
  if (isCryptoError(e, 'decrypt') || isCryptoError(e, 'unwrap')) return 'This could not be decrypted with your keys.';
  if (isCryptoError(e, 'params')) return 'The server sent unsafe key settings, so Inked refused to use them.';
  if (isCryptoError(e)) return e.message;
  return fallback;
}

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}
