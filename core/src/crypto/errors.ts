export type CryptoErrorCode =
  | 'decrypt' // authentication failed: wrong key, wrong AAD or tampered ciphertext
  | 'unwrap' // key unwrap failed: wrong password / recovery key, or tampered wrapped key
  | 'format' // malformed ciphertext, encoding or recovery key
  | 'params'; // unacceptable KDF parameters

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

export function isCryptoError(e: unknown, code?: CryptoErrorCode): e is CryptoError {
  return e instanceof CryptoError && (code === undefined || e.code === code);
}
