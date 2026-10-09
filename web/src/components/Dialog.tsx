import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { prefs } from '../lib/prefs';
import { usePresence } from '../motion';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** id of the element describing the dialog */
  describedBy?: string;
}

/** Native <dialog> (focus trap, Esc, inert background) with our styling. */
export function Dialog({ open, title, onClose, children, describedBy }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const presence = usePresence(open, 220);
  const presenceRef = presence.ref;
  const setEl = useCallback(
    (el: HTMLDialogElement | null) => {
      ref.current = el;
      presenceRef(el);
    },
    [presenceRef],
  );
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={setEl}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // Click on the backdrop closes.
        if (e.target === ref.current) onClose();
      }}
    >
      {/* Body stays mounted through the close transition so the exit fades real content. */}
      {presence.mounted && (
        <div className="dialog-body">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);
  const msgId = useId();
  return (
    <Dialog open={open} title={title} onClose={() => !busy && onClose()} describedBy={msgId}>
      <div id={msgId} className="dialog-text">
        {message}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(e instanceof Error && e.message ? e.message : 'That didn’t work. Try again.');
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

export function PromptDialog({
  open,
  title,
  label,
  initial = '',
  submitLabel = 'Create',
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  submitLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setBusy(false);
      setError(null);
    }
  }, [open, initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) {
      setError('Enter a name.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(v);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={title} onClose={() => !busy && onClose()}>
      <form onSubmit={submit} className="stack-8">
        <label className="field-label" htmlFor="prompt-input">
          {label}
        </label>
        <input
          id="prompt-input"
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={prefs.spellcheck()}
          maxLength={200}
          disabled={busy}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SelectDialog({
  open,
  title,
  label,
  options,
  initial,
  submitLabel = 'Move',
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  options: { value: string; label: string }[];
  initial: string;
  submitLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setBusy(false);
      setError(null);
    }
  }, [open, initial]);
  return (
    <Dialog open={open} title={title} onClose={() => !busy && onClose()}>
      <form
        className="stack-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(value);
            onClose();
          } catch (err) {
            setError(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
            setBusy(false);
          }
        }}
      >
        <label className="field-label" htmlFor="select-input">
          {label}
        </label>
        <select id="select-input" className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Moving…' : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
