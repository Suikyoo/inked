import { describe, expect, it } from 'vitest';
import { CryptoError } from 'inked-core';
import { ApiError, CredentialStale, NonApiResponse, ToolError } from '../src/errors';
import { auditCode, toToolMessage } from '../src/messages';

describe('toToolMessage', () => {
  it.each([
    [new ToolError('denied', 'Not permitted by the Inked MCP config: note.update.'), 'Not permitted by the Inked MCP config: note.update.'],
    [new CredentialStale(), 'Inked credential is stale (password changed?). Run `inked-mcp login`.'],
    [new NonApiResponse(403), 'Server returned a non-API response (Cloudflare challenge or proxy page?). See docs/mcp.md#cloudflare.'],
    [new ApiError(429, 'locked', undefined, 60), 'Inked is refusing sign-ins for now. Try again in 60 s.'],
    [new ApiError(413, 'too_large'), 'Note is too large (about 1.5 MB of text is the limit).'],
    [new ApiError(404, 'not_found'), 'Not found.'],
    [new ApiError(0, 'network'), 'Can’t reach the Inked server.'],
    [new ApiError(409, 'user_mismatch'), 'Session error. Restart the Inked MCP server.'],
    [new ApiError(500, 'internal'), 'Inked server error (500 internal).'],
    [new CryptoError('decrypt', 'x'), 'Cannot decrypt this item.'],
  ])('%s', (e, msg) => expect(toToolMessage(e)).toBe(msg));
});

describe('auditCode', () => {
  it('never carries a message, only a code', () => {
    expect(auditCode(new ToolError('not_found', 'Folder "Secret plans" not found.'))).toBe('tool_not_found');
    expect(auditCode(new ApiError(413, 'too_large'))).toBe('api_too_large');
    expect(auditCode(new CredentialStale())).toBe('credential_stale');
    expect(auditCode(new Error('Secret plans'))).toBe('error');
  });
});
