# chute

Telegram → Cloudflare Worker → GitHub commits. Drop a thought from your phone; it lands as a
markdown commit in a repo you own. This file is repo context for anyone — human or agent —
making changes here.

## What is true now
- 53 tests, `npm test`, Node 20+. No network, no credentials, no dependencies.
- Zero dependencies on purpose. Wrangler is invoked via `npx wrangler@latest`, never pinned in
  `package.json`. If something here ever needs an `npm install`, that is a decision to argue
  for, not a convenience to add.
- Every secret and id is read through `envValue` (`src/lib/env.js`) so a paste with a stray
  newline or wrapping quotes can't cause a silent 401. New config reads follow that rule.

## Scope
Capture only: the Telegram webhook (text/photo/document/sticker/GIF/voice/video, single-owner
filter), the `POST /capture` share-sheet lane, `#tg`/`#share` tags, optimistic-locked GitHub
commits with 409 retry, optional Whisper transcription.

What happens to a capture file afterwards — organizing, summarizing, reminding, syncing — is
deliberately out of scope. Those belong in whatever reads the files, not in the thing that
writes them. Proposing a feature past that line is a product decision: open an issue first.

## Rules
- **Zero AI trailers or tool attribution** in commits, code, or docs. Ever.
- **No secrets and no personal identifiers in the tree.** Config comes from env vars and
  wrangler secrets only. Before any commit, grep for tokens, chat ids, and private repo or
  vault names.
- **Tests stay hermetic.** A test that needs live Telegram or GitHub is wrong here — stub the
  network, as the existing suites do.
- **Nothing is filed silently.** A capture the worker cannot read still leaves a line saying
  so. A change that makes some input vanish without a trace is a bug, however tidy it looks.
- **Releases are the maintainer's call.** Stage the steps, don't run them.

## Truth sources
- README.md — the product surface; keep it honest, no hype, limitations stated plainly.
- `test/` — the behaviour contract. If you change what gets filed, a test should say so.
