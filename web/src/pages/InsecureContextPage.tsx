import { AuthLayout } from './AuthLayout';

export function InsecureContextPage() {
  return (
    <AuthLayout
      title="Inked needs a secure connection"
      lead="Encryption runs in your browser, and browsers only allow it over HTTPS or on localhost. Open Inked through an HTTPS address (for example behind a reverse proxy with a certificate), or on this machine at http://localhost."
    >
      {null}
    </AuthLayout>
  );
}
