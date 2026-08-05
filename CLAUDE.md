# chute

Public open-source tool: Telegram → Cloudflare Worker → GitHub commits. Drop a thought from
your phone; it lands as a markdown commit in a repo you own. Born 2026-08-05 as the sanitized
public twin of the owner's private capture pipeline — the private deployment lives elsewhere,
keeps running, and is NEVER touched from this repo.

## What is true now
- Fresh-history repo, one commit lineage, no remote yet. Ship = owner runs SHIP_RUNBOOK.md.
- 46 tests, `npm test`, no network needed. Keep it that way — tests that need live Telegram or
  GitHub are wrong here.
- Scope is capture only: Telegram webhook (text/photo/document/sticker/GIF/voice/video,
  single-owner filter), `POST /capture` share-sheet lane, `#tg`/`#share` tags,
  optimistic-locked GitHub commits with 409 retry, optional Whisper transcription.
  The owner's private system carries more (board sync, prompts, journal); none of it belongs
  here — adding life-management features to chute is a product decision, ask first.

## Laws
- **PUBLIC repo: zero AI trailers/attribution** in commits, code, or docs. Ever.
- **No secrets, no owner-specific identifiers.** Config via env/wrangler secrets only. Before
  any commit: grep for tokens, chat IDs, and the owner's private repo/vault names.
- **Publishing (push, repo create, release, posts) is owner-only.** Stage runbooks, never run.
- Tool, not product (owner standing rule 2026-08-05) — public lane is open, but every outward
  click is still his.

## Truth sources
- SHIP_RUNBOOK.md — the staged ship steps and their status.
- README.md — the product surface; keep honest, no hype, limitations stated.
