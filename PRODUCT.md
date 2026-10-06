# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Undecided. Must ship as Docker containers orchestrated by a `compose.yaml`. (Inferred from brief; frontend/backend framework not yet chosen.)

## Users

Primary user: the owner (a developer) and possibly a small number of trusted people, self-hosting a private knowledge base. They write and browse personal/technical notes daily at a desk. (Assumption: single-user or small-team; not yet confirmed.)

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
- Notes are never stored as plaintext .md; encryption scheme is an open decision pending a security review.
- Dockerized, compose-based deployment.
- Open: multi-user vs single-user, key derivation (login password vs separate vault key), sync, attachments.

## Evidence on Hand

None yet. No real note content, logos, or brand assets exist; any demo vault content is synthetic.

## Product Principles

- Find first: search is the front door.
- Structure is visible: hierarchy becomes a map without extra work.
- Private by construction: plaintext never touches disk.
- Writing stays plain Markdown, portable and standard.
