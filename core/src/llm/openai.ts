import type { ChatMessage } from '../rag/prompt';

export type LlmErrorKind = 'auth' | 'rate' | 'network' | 'http' | 'cut' | 'aborted';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly status?: number,
  ) {
    super(kind);
    this.name = 'LlmError';
  }
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
  maxTokens?: number;
}

export function llmOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function isAllowedBaseUrl(baseUrl: string, origins: readonly string[]): boolean {
  const o = llmOrigin(baseUrl);
  return o !== null && origins.includes(o);
}

/** Streams an OpenAI-compatible chat completion, yielding text deltas. Throws LlmError. */
export async function* chat(opts: ChatOptions): AsyncGenerator<string> {
  const f = opts.fetch ?? fetch;
  const aborted = () => opts.signal?.aborted === true;
  let res: Response;
  try {
    res = await f(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new LlmError(aborted() ? 'aborted' : 'network');
  }
  if (!res.ok || !res.body) {
    const s = res.status;
    throw new LlmError(s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate' : 'http', s);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let finished = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new LlmError(aborted() ? 'aborted' : 'cut');
      }
      const eof = chunk.done;
      buf += eof ? dec.decode() : dec.decode(chunk.value, { stream: true });
      // At EOF, also process a final line that has no trailing newline.
      while (buf.indexOf('\n') >= 0 || (eof && buf.length > 0)) {
        const nl = buf.indexOf('\n');
        const end = nl >= 0 ? nl : buf.length;
        const line = buf.slice(0, end).trim();
        buf = buf.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          finished = true;
          return;
        }
        let msg: { choices?: { delta?: { content?: unknown } }[]; error?: unknown };
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        if (msg.error) throw new LlmError('http');
        const content = msg.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content) yield content;
      }
      if (eof) break;
    }
    throw new LlmError(aborted() ? 'aborted' : 'cut');
  } finally {
    if (!finished) {
      // Abandoned or failed: stop the provider from generating into a dead stream.
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      /* already errored */
    }
  }
}
