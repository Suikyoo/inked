import type { ReactNode } from 'react';
import { Logo } from '../brand/Logo';

export function AuthLayout({
  title,
  lead,
  children,
  footer,
  wide = false,
}: {
  title?: string;
  lead?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="auth-screen">
      <main className={wide ? 'auth-col is-wide' : 'auth-col'}>
        <div className="auth-head">
          <Logo size={44} />
          <h1 className="auth-wordmark">Inked</h1>
          {title && <h2 className="auth-title">{title}</h2>}
          {lead && <p className="auth-lead">{lead}</p>}
        </div>
        {children}
        {footer && <div className="auth-foot">{footer}</div>}
      </main>
    </div>
  );
}
