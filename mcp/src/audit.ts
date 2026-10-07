import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { auditPath } from './home';

export interface AuditEntry {
  tool: string;
  ok: boolean;
  vaultId?: string;
  ids?: string[];
  /** An auditCode(), never a message. */
  error?: string;
}

/** One JSON line per tool call: what was touched, never what it says. */
export class Audit {
  constructor(private readonly file = auditPath()) {}

  write(e: AuditEntry): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n', { mode: 0o600 });
    } catch {
      // The audit log must never break a tool call.
    }
  }
}
