import { isCryptoError } from 'inked-core';
import { ApiError, CredentialStale, NonApiResponse, ToolError } from './errors';

/** One short sentence the model can act on. Never includes keys, cookies or content. */
export function toToolMessage(e: unknown): string {
  if (e instanceof ToolError || e instanceof CredentialStale || e instanceof NonApiResponse) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Can’t reach the Inked server.';
    if (e.status === 429) return `Inked is refusing sign-ins for now. Try again in ${e.retryAfter ?? 60} s.`;
    if (e.status === 413) return 'Note is too large (about 1.5 MB of text is the limit).';
    if (e.status === 404) return 'Not found.';
    if (e.code === 'user_mismatch') return 'Session error. Restart the Inked MCP server.';
    return `Inked server error (${e.status} ${e.code}).`;
  }
  if (isCryptoError(e)) return 'Cannot decrypt this item.';
  return 'Unexpected error in the Inked MCP server.';
}

/** A code for the audit log: never a message, which could carry a name the user typed. */
export function auditCode(e: unknown): string {
  if (e instanceof ToolError) return `tool_${e.kind}`;
  if (e instanceof ApiError) return `api_${e.code}`;
  if (e instanceof CredentialStale) return 'credential_stale';
  if (e instanceof NonApiResponse) return 'non_api_response';
  if (isCryptoError(e)) return `crypto_${e.code}`;
  return 'error';
}
