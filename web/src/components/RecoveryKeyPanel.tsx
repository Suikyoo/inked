import { useState } from 'react';
import { copyText } from '../lib/util';
import { FormError, Spinner } from './Fields';
import { CheckIcon, CopyIcon } from './Icons';

/**
 * Shows a freshly made recovery key once, with copy and an "I saved it" check that gates the
 * done button. The key lives only in the caller's state. `busy` and `error` report the caller's
 * work on done (e.g. telling the server about the new key).
 */
export function RecoveryKeyPanel({
  recoveryKey,
  onDone,
  doneLabel,
  busy = false,
  error = null,
}: {
  recoveryKey: string;
  onDone: () => void;
  doneLabel: string;
  busy?: boolean;
  error?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const groups = recoveryKey.split('-');
  const prefix = groups.slice(0, 2).join('-') + '-';
  const body = groups.slice(2);

  return (
    <>
      <div className="rk-panel">
        <p className="rk-key" aria-label="Recovery key">
          <span className="rk-prefix">{prefix}</span>
          {body.map((g, i) => (
            <span key={i} className="rk-group">
              {g}
              {i < body.length - 1 ? '-' : ''}
            </span>
          ))}
        </p>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setCopied(await copyText(recoveryKey));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy recovery key'}
        </button>
        <p className="field-hint">Keep it in a password manager or print it. Don’t store it next to your password.</p>
      </div>
      <div className="auth-form">
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={busy} />
          <span>I saved my recovery key somewhere safe</span>
        </label>
        <button type="button" className="btn btn-primary btn-block" disabled={!saved || busy} onClick={onDone}>
          {busy && <Spinner />}
          {doneLabel}
        </button>
        <FormError>{error}</FormError>
      </div>
    </>
  );
}
