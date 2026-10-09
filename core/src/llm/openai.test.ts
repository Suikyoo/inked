import { describe, expect, it, vi } from 'vitest';
import { chat, isAllowedBaseUrl, LlmError, llmOrigin } from './openai';

const enc = new TextEncoder();
function streamOf(parts: string[], { fail = false } = {}) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      if (fail) c.error(new Error('reset'));
      else c.close();
    },
  });
}
const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const okFetch = (parts: string[], opts?: { fail?: boolean }) =>
  vi.fn(async () => new Response(streamOf(parts, opts), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
const base = { baseUrl: 'https://api.example.com/v1/', apiKey: 'k', model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

async function collect(it: AsyncGenerator<string>) {
  let s = '';
  for await (const d of it) s += d;
  return s;
}
async function kindOf(p: Promise<unknown>) {
  try {
    await p;
    return 'none';
  } catch (e) {
    return (e as LlmError).kind;
  }
}

describe('chat', () => {
  it('posts to /chat/completions with stream and bearer key, and yields deltas until [DONE]', async () => {
    const f = okFetch([delta('Hel'), delta('lo'), 'data: [DONE]\n\n']);
    const key = 'sk-test-key-123';
    expect(await collect(chat({ ...base, apiKey: key, fetch: f }))).toBe('Hello');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm', stream: true, messages: base.messages });
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(url).not.toContain(key);
    expect(init.body as string).not.toContain(key);
  });
  it('joins a data line split across reads', async () => {
    const line = delta('split');
    const f = okFetch([line.slice(0, 10), line.slice(10), 'data: [DONE]\n\n']);
    expect(await collect(chat({ ...base, fetch: f }))).toBe('split');
  });
  it('ignores comments, blank lines and deltas without content', async () => {
    const f = okFetch([': ping\n\n', `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`, delta('x'), 'data: [DONE]\n\n']);
    expect(await collect(chat({ ...base, fetch: f }))).toBe('x');
  });
  it('maps statuses to kinds', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate'], [500, 'http']] as const) {
      const f = vi.fn(async () => new Response('{}', { status }));
      expect(await kindOf(collect(chat({ ...base, fetch: f })))).toBe(kind);
    }
  });
  it('maps a rejected fetch to network', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await kindOf(collect(chat({ ...base, fetch: f })))).toBe('network');
  });
  it('reports cut when the stream ends without [DONE] or errors', async () => {
    expect(await kindOf(collect(chat({ ...base, fetch: okFetch([delta('a')]) })))).toBe('cut');
    expect(await kindOf(collect(chat({ ...base, fetch: okFetch([delta('a')], { fail: true }) })))).toBe('cut');
  });
  it('parses a final [DONE] that has no trailing newline', async () => {
    const f = okFetch([delta('a'), 'data: [DONE]']);
    expect(await collect(chat({ ...base, fetch: f }))).toBe('a');
  });
  it('cancels the HTTP stream when the consumer stops early', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(delta('a') + delta('b') + 'data: [DONE]\n\n'));
      },
      cancel,
    });
    const f = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    for await (const d of chat({ ...base, fetch: f })) {
      expect(d).toBe('a');
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('reports an error object in the stream as http without a status', async () => {
    const f = okFetch([`data: ${JSON.stringify({ error: { message: 'bad' } })}\n\n`]);
    const err = await collect(chat({ ...base, fetch: f })).catch((e: unknown) => e as LlmError);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('http');
    expect((err as LlmError).status).toBeUndefined();
  });
  it('reports aborted when the signal fires', async () => {
    const ac = new AbortController();
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal });
    });
    expect(await kindOf(collect(chat({ ...base, fetch: f as never, signal: ac.signal })))).toBe('aborted');
  });
});

describe('origins', () => {
  it('reads the origin of a base URL', () => {
    expect(llmOrigin('https://api.openai.com/v1')).toBe('https://api.openai.com');
    expect(llmOrigin('not a url')).toBeNull();
  });
  it('allows only listed origins', () => {
    expect(isAllowedBaseUrl('https://api.openai.com/v1', ['https://api.openai.com'])).toBe(true);
    expect(isAllowedBaseUrl('https://evil.example/v1', ['https://api.openai.com'])).toBe(false);
    expect(isAllowedBaseUrl('nope', ['https://api.openai.com'])).toBe(false);
  });
});
