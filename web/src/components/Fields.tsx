import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertIcon, EyeIcon, EyeOffIcon } from './Icons';

export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="form-error" role="alert">
      <AlertIcon size={12} />
      <span>{children}</span>
    </p>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { label: string; hint?: ReactNode };

export const TextField = forwardRef<HTMLInputElement, InputProps>(function TextField({ label, hint, ...rest }, ref) {
  const id = useId();
  const hintId = hint ? id + '-hint' : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input-wrap">
        <input ref={ref} id={id} className="input-bare" aria-describedby={hintId} {...rest} />
      </div>
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, InputProps>(function PasswordField(
  { label, hint, ...rest },
  ref,
) {
  const id = useId();
  const [show, setShow] = useState(false);
  const hintId = hint ? id + '-hint' : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input-wrap has-action">
        <input
          ref={ref}
          id={id}
          className="input-bare"
          type={show ? 'text' : 'password'}
          aria-describedby={hintId}
          spellCheck={false}
          autoCapitalize="off"
          {...rest}
        />
        <button
          type="button"
          className="input-action"
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          onClick={() => setShow((s) => !s)}
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
});

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? 'status' : undefined} aria-label={label} />;
}
