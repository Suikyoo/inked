import { useEffect, useState, type FormEvent } from 'react';
import { FormError } from '../components/Fields';
import { compileVimConfig, VIM_CONFIG_MAX } from '../editor/vimConfig';
import { describeError } from '../lib/util';
import { useAccountSettings, useAccountSettingsStore } from '../state/AccountSettingsContext';

/**
 * Vim mode for the note editor: the switch, and the owner's own keymaps.
 *
 * The config is a small Lua subset — `vim.keymap.set(...)` and `vim.o.<option> = ...` — parsed, never run.
 * Errors are shown with their line numbers as the owner types; a config that does not compile contributes no
 * keymaps at all, so vim's own defaults still work (the design's ruling 7).
 */
export function VimSettings() {
  const acc = useAccountSettings();
  const store = useAccountSettingsStore();
  const saved = acc.settings.vim;
  const [config, setConfig] = useState(saved?.config ?? '');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setConfig(saved?.config ?? ''), [saved?.config]);

  const on = saved?.on ?? false;
  const compiled = compileVimConfig(config);

  const save = async (vim: { on: boolean; config: string }) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await store.update((s) => ({ ...s, vim }));
      setStatus('Saved');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({ on: true, config });
  };

  return (
    <section className="card" id="vim" aria-labelledby="vim-h">
      <h2 id="vim-h" className="card-title">
        Vim
      </h2>
      <label className="check">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void save({ on: e.target.checked, config })} />
        <span>Vim keys in the note editor</span>
      </label>
      <p className="field-hint">
        Off by default. Modes, motions, operators, registers, macros and <code>/</code> search, as vim does them. A soft
        keyboard has no Escape, so this is for a real keyboard.
      </p>

      {on && (
        <form className="vim-config" onSubmit={submit} noValidate>
          <label className="field-label" htmlFor="vim-config">
            Your keymaps
          </label>
          <textarea
            id="vim-config"
            className="input vim-config-text"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            maxLength={VIM_CONFIG_MAX}
            spellCheck={false}
            rows={8}
            placeholder={"vim.g.mapleader = ' '\nvim.keymap.set('i', 'jk', '<Esc>')\nvim.keymap.set('n', '<leader>h', '^')"}
            disabled={busy}
          />
          <p className="field-hint">
            A small slice of Lua: <code>vim.keymap.set(mode, keys, action)</code>, <code>vim.o.&lt;option&gt; = value</code> and{' '}
            <code>vim.g.mapleader</code>,
            nothing else. It is read, never run, so <code>require</code>, <code>if</code> and functions are not available.
            One error means none of your keymaps apply, and vim&rsquo;s own defaults are used. Set <code>mapleader</code> above the
            mappings that use <code>&lt;leader&gt;</code>, as vim expands it where the mapping is written.
          </p>
          {compiled.errors.length > 0 && (
            <ul className="vim-errors">
              {compiled.errors.map((e, i) => (
                <li key={i} className="vim-error">
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="row-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save keymaps'}
            </button>
            {status && <span className="field-hint">{status}</span>}
          </div>
          <FormError>{error}</FormError>
        </form>
      )}
    </section>
  );
}

