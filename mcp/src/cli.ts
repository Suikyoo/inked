import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createInterface } from 'node:readline/promises';
import { Audit } from './audit';
import { deleteCredential, loadCredential, saveCredential } from './credential';
import { isCryptoError } from 'inked-core';
import { ApiError, NonApiResponse, ToolError } from './errors';
import { credentialPath } from './home';
import { toToolMessage } from './messages';
import { Ops } from './ops';
import { ConfigError, loadConfig, resolvePolicy } from './policy';
import { createCredential, Session } from './session';
import { createInkedServer } from './tools';
import { listAllVaults, VaultModel } from './vault-model';

const VERSION = '0.1.0';
const USAGE = `Usage: inked-mcp <command>

  login              Sign in once and save a credential (not your password) to ~/.inked-mcp
  serve [--config F] Run the MCP server over stdio (what your AI client starts)
  status [--config F] Show who you are signed in as and what the config allows
  logout             Delete the saved credential`;

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  ask(q: string): Promise<string>;
  askHidden(q: string): Promise<string>;
}

/** Reads a line from the terminal without echoing it (raw mode). */
function readHidden(q: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(q);
    if (!stdin.isTTY) return reject(new Error('A terminal is needed to type the password.'));
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled')));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  ask: async (q) => {
    // Prompts go to stderr so stdout stays clean.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
  askHidden: readHidden,
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function prepare(argv: string[], fetchImpl?: typeof fetch) {
  const cfg = loadConfig(flag(argv, '--config'));
  const session = new Session(loadCredential(), { fetch: fetchImpl });
  await session.start();
  try {
    const all = await listAllVaults(session);
    const policy = resolvePolicy(cfg, all);
    return { session, policy, all };
  } catch (e) {
    await session.close();
    throw e;
  }
}

function describeFailure(e: unknown): string {
  if (e instanceof ConfigError) return `Config error: ${e.message}`;
  if (e instanceof ApiError || e instanceof NonApiResponse || e instanceof ToolError || isCryptoError(e)) return toToolMessage(e);
  // CredentialStale, credential-file problems, a bad URL: their messages are written for the user.
  return e instanceof Error ? e.message : String(e);
}

export async function main(
  argv: string[],
  io: CliIO = defaultIO,
  deps: { fetch?: typeof fetch; connect?: (server: McpServer) => Promise<void> } = {},
): Promise<number> {
  const cmd = argv[0] ?? 'serve';
  try {
    if (cmd === 'login') {
      const baseUrl = flag(argv, '--url') ?? (await io.ask('Inked URL (e.g. https://notes.example.com): '));
      const username = flag(argv, '--username') ?? (await io.ask('Username: '));
      const password = await io.askHidden('Password: ');
      let cred;
      try {
        cred = await createCredential({ baseUrl, username, password }, { fetch: deps.fetch });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          io.err('Wrong username or password.');
          return 1;
        }
        throw e;
      }
      saveCredential(cred);
      io.out(`Saved a credential for ${cred.username} at ${cred.baseUrl} to ${credentialPath()}.`);
      io.out('It is not your password, but it can read and write your notes. Change your Inked password to revoke it.');
      return 0;
    }

    if (cmd === 'logout') {
      const removed = deleteCredential();
      io.out(removed ? 'Credential deleted.' : 'No credential was saved.');
      io.out('If a copy of it may exist elsewhere, change your Inked password to revoke it.');
      return 0;
    }

    if (cmd === 'status') {
      const { session, policy, all } = await prepare(argv, deps.fetch);
      try {
        io.out(`Signed in as ${session.username} at ${session.baseUrl}`);
        io.out(
          policy.allVaults
            ? 'Vaults: all (*)'
            : `Vaults: ${all.filter((v) => policy.vaultIds.has(v.id)).map((v) => `${v.name} (${v.id})`).join(', ')}`,
        );
        io.out(`Actions: ${[...policy.actions].sort().join(', ')}`);
        io.out(`Writes per minute: ${policy.writesPerMinute}`);
      } finally {
        await session.close();
      }
      return 0;
    }

    if (cmd === 'serve') {
      const { session, policy } = await prepare(argv, deps.fetch);
      const ops = new Ops(session, new VaultModel(session, policy), policy);
      const { server, registered } = createInkedServer({ ops, policy, audit: new Audit(), version: VERSION });
      io.err(`inked-mcp ${VERSION}: ${session.username} at ${session.baseUrl}; tools: ${registered.join(', ')}`);
      // Close the session, but never wait more than a few seconds: a hung logout must not keep the key in memory.
      const closeSession = () =>
        Promise.race([session.close().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 3000))]);
      let closing = false;
      const shutdown = async () => {
        if (closing) process.exit(0); // a second signal while closing: leave at once
        closing = true;
        await closeSession();
        process.exit(0);
      };
      const signals = ['SIGINT', 'SIGTERM'] as const;
      const removeHandlers = () => {
        for (const sig of signals) process.off(sig, shutdown);
        process.stdin.off('end', shutdown);
      };
      try {
        if (deps.connect) {
          await deps.connect(server);
          await session.close();
          return 0;
        }
        for (const sig of signals) process.on(sig, shutdown);
        process.stdin.on('end', shutdown);
        await server.connect(new StdioServerTransport());
        return 0;
      } catch (e) {
        removeHandlers();
        await closeSession();
        throw e;
      }
    }

    io.err(USAGE);
    return 2;
  } catch (e) {
    io.err(describeFailure(e));
    return 1;
  }
}

// Run when executed directly (the bundled CJS bin), not when vitest imports this file as ESM.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
