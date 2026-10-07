# Inked MCP server

## What it is

`inked-mcp` is a local MCP server that lets an AI client (Claude Code, Claude Desktop, Cursor and others) read and write your Inked notes. It runs on your machine, over stdio, and acts as you: it signs in, decrypts and encrypts everything locally, and talks to your Inked server through the normal API. The Inked server stays zero-knowledge. It never sees your password, a key that can decrypt, or any plaintext, and it cannot tell the MCP from a browser.

You decide what the AI may do. A config file lists which vaults it may touch and which actions it may take. Tools you do not grant are never registered, so the AI never sees them. There is no delete tool under any config.

One thing to understand clearly: whatever the MCP returns to the AI client (note titles, bodies, search results) leaves your device and goes to the model provider behind that client. That is inherent to using an AI with your notes, and it is your choice. Only grant access to vaults you are comfortable sharing that way.

## Install

From the repository root:

```bash
npm install
```

```bash
npm run build -w mcp
```

```bash
npm install -g ./mcp
```

Check that it works:

```bash
inked-mcp status
```

Before you sign in, `status` tells you to run `inked-mcp login` first. After signing in it shows who you are, the vaults and actions the config allows, and the write limit.

## Sign in

```bash
inked-mcp login
```

It asks for your Inked URL, your username and your password. You can pass the first two as `--url` and `--username` to skip those prompts. The password is typed hidden and is never saved.

What is saved is a credential file at `~/.inked-mcp/credential.json`: the URL, your username and the master secret derived from your password. The master secret is enough to sign in and decrypt your data, but it cannot reveal your password. Any program running as your user can read the file, so treat it like a key.

To revoke it, change your Inked password. The saved credential then stops working and the server ends your other sessions. `inked-mcp logout` deletes the file on this machine, but it cannot revoke a copy that may exist somewhere else, so change your password if that matters.

If you run `inked-mcp login` again while an AI client is open, restart the client so it starts a fresh `serve`. A running server keeps the old credential.

The default folder is `~/.inked-mcp`. Set the `INKED_MCP_HOME` environment variable to use another folder for the credential, config and audit log.

## Choose what the AI may do

The config file is `~/.inked-mcp/config.json`. If it does not exist, the default is read-only access to every vault.

```json
{
  "version": 1,
  "vaults": ["Research"],
  "actions": ["@read", "note.create"],
  "limits": { "writesPerMinute": 120 }
}
```

- `version` must be `1`.
- `vaults` is `"*"` for all vaults, or a non-empty list of vault names or ids. Names are matched exactly after decryption. An unknown name, or a name shared by two vaults, stops the server with a clear error (use the id instead).
- `actions` is a non-empty list of actions or groups.
- `limits.writesPerMinute` is optional, a whole number from 1 to 1000. The default is 120.

The config is checked strictly. A typo or an unknown key stops the server rather than quietly changing what the AI can do. The vault allowlist is enforced inside the MCP process only.

### Actions

| Action | Tool | What it allows |
|---|---|---|
| `vault.list` | `list_vaults` | List the vaults you may use |
| `tree.read` | `get_tree` | Read a vault's folder tree and note titles |
| `note.read` | `read_note` | Read a note's title and body |
| `search` | `search` | Fuzzy search over titles and bodies |
| `folder.create` | `create_folder` | Create a folder (its Index note is created too) |
| `note.create` | `create_note`, `create_notes` | Create one note, or 1 to 50 in a batch |
| `note.append` | `append_to_note` | Add text to the end of a note |
| `note.update` | `update_note` | Replace a note's title and/or body |
| `note.move` | `move_note` | Move a note to another folder in the same vault |
| `folder.rename` | `rename_folder` | Rename a folder |
| `folder.move` | `move_folder` | Move a folder within the same vault |

### Groups

| Group | Expands to |
|---|---|
| `@read` | `vault.list`, `tree.read`, `note.read`, `search` |
| `@write` | `folder.create`, `note.create`, `note.append`, `note.update` |
| `@organize` | `note.move`, `folder.rename`, `folder.move` |

### Never grantable

These do not exist as tools and no config can add them:

- deleting notes or folders
- creating, renaming or deleting vaults
- changing your password, the recovery key, invites or admin tasks

Do these in the Inked web app.

### Example configs

Read-only, all vaults:

```json
{"version":1,"vaults":"*","actions":["@read"]}
```

Capture into one vault (read, create notes, append):

```json
{"version":1,"vaults":["Inbox"],"actions":["@read","note.create","note.append"]}
```

Research builder (read, write and reorganize in one vault, with an explicit write limit):

```json
{"version":1,"vaults":["Research"],"actions":["@read","@write","@organize"],"limits":{"writesPerMinute":120}}
```

To see what a config resolves to, run `inked-mcp status`. To check another file without moving it, pass `--config`:

```bash
inked-mcp status --config ./capture.json
```

### Different policies for different clients

`serve` accepts `--config`, so each client can use its own file:

```bash
inked-mcp serve --config ~/.inked-mcp/capture.json
```

Put that command and its arguments in the client's MCP settings (see below). A file given with `--config` that does not exist is an error, not a fallback to the default.

After you edit a config, restart the AI client so it starts `serve` again.

## Connect a client

### Claude Code (plugin)

The repository includes a Claude Code plugin that bundles the MCP server and the `inked-notes` skill, which teaches the AI to orient itself, search before writing, and link notes. Install the CLI first (above), then add the repository as a marketplace and install the plugin:

```bash
claude plugin marketplace add <path-to-repo>
```

```bash
claude plugin install inked@inked
```

Inside a session you can use `/plugin marketplace add <path-to-repo>` and `/plugin install inked@inked` instead. In Claude Code the tools appear as `mcp__plugin_inked_inked__<tool>`, for example `mcp__plugin_inked_inked__list_vaults`.

The plugin runs `inked-mcp serve` with the default folder, so it uses the credential and config you set up above. `inked-mcp` must be on your PATH.

Without the plugin, add the server directly. Options go before the name; omit `--env` to use the default `~/.inked-mcp`:

```bash
claude mcp add --env INKED_MCP_HOME=<dir> --transport stdio inked -- inked-mcp serve
```

### Claude Desktop

Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "inked": { "command": "inked-mcp", "args": ["serve"] }
  }
}
```

To give Claude the same guidance the plugin gives, upload the folder `mcp/plugin/skills/inked-notes` as a skill in Claude Desktop's skill settings.

### Cursor

Add this to `.cursor/mcp.json` (project) or your global Cursor MCP settings:

```json
{
  "mcpServers": {
    "inked": { "command": "inked-mcp", "args": ["serve"] }
  }
}
```

In any client, add `"--config", "<file>"` to `args` to use a specific policy.

## Audit log

Every tool call is recorded as one JSON line in `~/.inked-mcp/audit.log`: the time, the tool, the vault id, the ids touched, whether it succeeded, and a short error code on failure. It never records titles, bodies, folder names or vault names, and never any key or secret. The log is local only; the Inked server cannot tell MCP calls from browser use.

## Troubleshooting

### Cloudflare blocks the MCP {#cloudflare}

If your Inked is behind Cloudflare, Bot Fight Mode or Super Bot Fight Mode can challenge clients that are not browsers, so `login` or `serve` fails because it gets a web page instead of an API response. Either add a WAF custom rule that skips bot protection for `/api/*` on the Inked hostname, or turn the mode off for that hostname.

### "Inked credential is stale"

Your password changed (or the credential was revoked). Run `inked-mcp login` again, then restart the AI client.

### "Not permitted by the Inked MCP config"

The AI asked for an action your config does not grant. Edit `~/.inked-mcp/config.json` (or the file you pass with `--config`), then restart the client.

### "Write limit reached"

More writes than `limits.writesPerMinute` in a minute. Wait a moment, or raise the limit in the config (up to 1000) and restart the client.

### Config error

`serve` and `status` stop with `Config error: ...` when the config has a typo, an unknown action, or a vault name that is missing or ambiguous. The message says which. Fix the file and try again.
