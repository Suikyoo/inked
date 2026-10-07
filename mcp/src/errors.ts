/** An HTTP error from the Inked API (status 0 = network failure). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly retryAfter?: number,
  ) {
    super(message || code);
    this.name = 'ApiError';
  }
}

/** The server answered with something that is not the Inked JSON API (a Cloudflare challenge, a proxy page). */
export class NonApiResponse extends Error {
  constructor(readonly status: number) {
    super('Server returned a non-API response (Cloudflare challenge or proxy page?). See docs/mcp.md#cloudflare.');
    this.name = 'NonApiResponse';
  }
}

/** The saved credential no longer signs in, typically after a password change. */
export class CredentialStale extends Error {
  constructor() {
    super('Inked credential is stale (password changed?). Run `inked-mcp login`.');
    this.name = 'CredentialStale';
  }
}

export type ToolErrorKind = 'denied' | 'not_found' | 'ambiguous' | 'invalid' | 'conflict' | 'rate_limited' | 'too_large';

/** A failure whose message is written for the model and is safe to show as-is. */
export class ToolError extends Error {
  constructor(
    readonly kind: ToolErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
