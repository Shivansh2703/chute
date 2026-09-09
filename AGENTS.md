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
- **Commits, code, and docs carry a single named author only** — no co-author trailers
  or tool-attribution lines. Ever.
- **No secrets and no personal identifiers in the tree.** Config comes from env vars and
  wrangler secrets only. Before any commit, grep for tokens, chat ids, and private repo or
  vault names.
- **Tests stay hermetic.** A test that needs live Telegram or GitHub is wrong here — stub the
  network, as the existing suites do.
- **Nothing is filed silently.** A capture the worker cannot read still leaves a line saying
  so. A change that makes some input vanish without a trace is a bug, however tidy it looks.
- **Releases are the maintainer's call.** Stage the steps, don't run them.

## Check
`npm test` — 313 assertions, Node 20+, ~4s, zero installs (no `node_modules` to build: the
suite has no dependencies and stubs every network call). Proves the Telegram webhook, the
`/capture` share-sheet lane, filename-refusal logic, and the GitHub commit/retry path all
still behave. CI runs it on every push and PR to `main`, on Node 20 and 22
(`.github/workflows/test.yml`).

Red means a real regression, not flakiness — there is no network or timing dependency to
retry past. Read the failing test name first; it names the behaviour that broke. Never
comment out or loosen an assertion to get back to green.

Not covered: the Cloudflare Worker deploy itself (`wrangler deploy`), the live Telegram and
GitHub API calls (all stubbed), and Whisper transcription output quality.

## Truth sources
- README.md — the product surface; keep it honest, no hype, limitations stated plainly.
- `test/` — the behaviour contract. If you change what gets filed, a test should say so.
