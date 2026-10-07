# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 18 + Vite + TypeScript (web), Fastify 5 + node:sqlite (server), shipped as Docker containers via `compose.yaml` with nginx in front and cloudflared for the tunnel. Encryption is browser-side and zero-knowledge.

## Users

Several people on one self-hosted instance: an admin plus users added by invite. They write and browse personal/technical notes daily at a desk. Each user has their own encrypted vaults; the server only ever holds ciphertext.

## Product Purpose

A self-hosted notes app that crosses Notion (block-friendly, polished editing) with Obsidian (vaults, folder/file hierarchy, graph view). Notes are encrypted at rest so a leaked disk or database yields only ciphertext. Success: the owner finds any note in seconds from a search-engine-style home, and sees how a vault's knowledge clusters.

## Positioning

The home screen is the vault map: every vault rendered as a concept-map cluster, with a single fuzzy search bar on top like a search engine. Connections come from folder hierarchy (not only explicit links), so structure is visible without manual linking. Everything stored encrypted.

## Operating Context

- Login gated by password.
- Vaults (Obsidian-style), each holding folders and notes in a tree.
- Markdown notes with an edit | view toggle (raw syntax vs rendered).
- Concept map per vault; edges derived from folder hierarchy (folder → subfolder → note), plus explicit links when present.
- Fuzzy search across notes.

## Capabilities and Constraints

- Markdown rendering must follow standards (CommonMark / GFM assumed).
- Notes are never stored as plaintext .md; encryption is browser-side and zero-knowledge.
- Dockerized, compose-based deployment.
- Multi-user with admin and invites; keys are derived in the browser. Open: sync, attachments.

## Evidence on Hand

None yet. No real note content, logos, or brand assets exist; any demo vault content is synthetic.

## Product Principles

- Find first: search is the front door.
- Structure is visible: hierarchy becomes a map without extra work.
- Private by construction: plaintext never touches disk.
- Writing stays plain Markdown, portable and standard.
