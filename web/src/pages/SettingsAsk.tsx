import { chat, isAllowedBaseUrl, LlmError, llmOrigin } from 'inked-core';
import { useEffect, useState, type FormEvent } from 'react';
import { askErrorMessage } from '../ask/messages';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { describeError } from '../lib/util';
import { useAccountSettings, useAccountSettingsStore } from '../state/AccountSettingsContext';

export function AskSettings({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const acc = useAccountSettings();
  const store = useAccountSettingsStore();
  const saved = acc.settings.llm;
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [model, setModel] = useState(saved?.model ?? '');
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? '');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBaseUrl(saved?.baseUrl ?? '');
    setModel(saved?.model ?? '');
    setApiKey(saved?.apiKey ?? '');
  }, [saved?.baseUrl, saved?.model, saved?.apiKey]);

  if (!acc.llmOrigins.length) return null;
  const origins = acc.llmOrigins.join(', ');
  const shownOrigin = (isAllowedBaseUrl(baseUrl.trim(), acc.llmOrigins) ? llmOrigin(baseUrl) : null) ?? acc.llmOrigins[0];

  const check = (): string | null => {
    if (!baseUrl.trim() || !model.trim() || !apiKey.trim()) return 'Enter a base URL, a model and an API key.';
    if (!isAllowedBaseUrl(baseUrl.trim(), acc.llmOrigins)) return `This deployment only allows: ${origins}.`;
    return null;
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setStatus(null);
    const bad = check();
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    try {
      const llm = { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() };
      await store.update((s) => ({ ...s, llm }));
      setStatus('Saved');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await store.update(({ llm: _drop, ...rest }) => rest);
      setStatus('Cleared');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setStatus(null);
    const bad = check();
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    try {
      const it = chat({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
        messages: [{ role: 'user', content: 'Reply with the word ok.' }],
        maxTokens: 5,
        fetch: fetchImpl,
      });
      for await (const _ of it) {
        /* read to the end so errors surface */
      }
      setStatus('Connected');
    } catch (err) {
      setError(err instanceof LlmError && err.kind !== 'aborted' ? askErrorMessage(err.kind, llmOrigin(baseUrl), err.status) : askErrorMessage('network', llmOrigin(baseUrl)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="ask-h">
      <h2 id="ask-h" className="card-title">
        Ask your notes
      </h2>
      <p className="field-hint">Questions and matching note excerpts are sent to {shownOrigin}. Nothing else leaves this browser.</p>
      {acc.unreadable && <p className="field-hint">Saved Ask settings couldn’t be read. Enter them again.</p>}
      <form className="form-narrow" onSubmit={save} noValidate>
        <TextField label="Base URL" type="url" autoComplete="off" spellCheck={false} placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} />
        <TextField label="Model" autoComplete="off" spellCheck={false} placeholder="gpt-4o-mini" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} />
        <PasswordField label="API key" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} />
        <FormError>{error}</FormError>
        {status && (
          <p className="ok-text" role="status">
            {status}
          </p>
        )}
        <div className="row-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void test()} disabled={busy}>
            {busy && <Spinner />}Test
          </button>
          {saved && (
            <button type="button" className="btn btn-sm" onClick={() => void clearAll()} disabled={busy}>
              Clear
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
