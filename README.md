# chute

Drop a thought from your phone. It lands as a commit in a repo you own.

`chute` is a small Cloudflare Worker that sits between Telegram (or an iOS/
Android share sheet) and a GitHub repo. Send it a message — text, a photo, a
voice note, a link — and it appends one timestamped line to today's file and
commits it. No app to check, no database to run, no third-party service that
holds your notes. The commit history is the log.

It is intentionally small. It does not organize, summarize, or remind you of
anything — it only gets a thought out of your head and into a file as fast as
possible, honestly, without losing it. What happens to that file afterwards —
an Obsidian vault, a script that sorts it, an agent that reads it — is not
this tool's problem, on purpose.

## Why

The best capture tool is the one that's always in your pocket. For most
people that's a messaging app, not a notes app. `chute` turns your phone's
share sheet and your Telegram client into a capture device for a plain-text
vault that lives in git — durable, diffable, greppable, yours.

## How it works

```
                 ┌──────────────┐
   Telegram ────▶│              │
   (text, photo, │   chute      │──── GitHub Contents API ────▶  your repo
   voice, video)  │  (Cloudflare │        (one commit per        captures/
                 │   Worker)    │         capture, appended      2026-01-15.md
   Share sheet ──▶│              │         to today's file)
   / Shortcuts /   └──────────────┘
   curl (POST /capture)
```

Two inbound lanes, one filing path:

- **`POST /telegram`** — a Telegram bot webhook. Only messages from the one
  Telegram user ID you configure are accepted; everyone else is silently
  dropped, no reply, nothing logged.
- **`POST /capture`** — a token-protected HTTP endpoint for anything that
  isn't Telegram: an iOS Shortcut bound to the share sheet or the Action
  Button, Siri, or a plain `curl` call. Takes `{ text, url }` JSON.

Both lanes write through the same function: read today's file from GitHub,
append a line, commit. Every capture becomes its own commit — that's the
audit trail. A capture that lands twice (a retried webhook, a doubled share)
is deduplicated by exact line match rather than written again.

Each line looks like:

```
- **14:32** — buy oat milk #tg
- **09:02** — [an article worth re-reading](https://example.com/post) #share
```

The `#tg` / `#share` tag says which lane a line came in on (both
configurable). See `examples/2026-01-15.md` for a fuller example, including
photo and voice captures.

### What it captures

| Input | Filed as |
| --- | --- |
| text message | the text, verbatim, newlines collapsed to `; ` |
| photo, with or without caption | `(photo) <caption or "no caption">` |
| document | `(document) <filename> — <caption>` |
| sticker | `(sticker) <emoji>` |
| GIF | `(gif) <caption>` |
| voice / video / video note / audio | transcript via Cloudflare Workers AI (optional — see Setup), or a stub saying why not |
| share-sheet text and/or URL | the text, the URL, or a markdown link of both |

Nothing is ever silently dropped. If a message arrives and something in it
can't be read or transcribed, the worker still files a line saying so — a
capture the tool can't process is still a capture, and a stub line is a
better failure mode than a message that vanished with no trace.

## Setup (about 15 minutes)

You need a Cloudflare account and a GitHub account. No servers to run.

**1. Create a Telegram bot**

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
follow the prompts. You'll get a bot token — keep it, you'll paste it into a
Cloudflare secret in step 4, never into a file.

Find your own numeric Telegram user ID (message
[@userinfobot](https://t.me/userinfobot)) — this is what restricts the bot to
you and drops everyone else's messages unread.

**2. Create a GitHub fine-grained personal access token**

GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token.

- Repository access: only the one repo you want captures written to
- Permissions: **Contents: Read and write** — nothing else

**3. Clone and install**

```
git clone <this-repo-url> chute
cd chute
npm install
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`: set `GITHUB_REPO` to `your-username/your-repo` and
`OWNER_ID` to the Telegram ID from step 1. `wrangler.toml` is gitignored, so
these values (not secret, but yours) never get committed.

**4. Set secrets**

```
npx wrangler login
npx wrangler secret put BOT_TOKEN         # from @BotFather
npx wrangler secret put WEBHOOK_SECRET    # generate: openssl rand -hex 32
npx wrangler secret put GITHUB_TOKEN      # from step 2
npx wrangler secret put CAPTURE_TOKEN     # generate: openssl rand -hex 32 — only needed for the share-sheet lane
```

**5. Deploy**

```
npx wrangler deploy
```

Note the `*.workers.dev` URL Wrangler prints.

**6. Register the Telegram webhook**

```
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/telegram" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

**7. Verify**

Send `capture: test` to your bot in Telegram. Expect a reply like
`filed ✓ 14:32` and a new commit on your repo touching
`captures/<today>.md`.

For the share-sheet lane, see `wrangler.toml.example` for the optional vars
and build an iOS Shortcut with one **Get Contents of URL** action: POST to
`https://<your-worker>.workers.dev/capture`, header
`Authorization: Bearer <CAPTURE_TOKEN>`, JSON body
`{"text": "...", "url": "..."}`.

## Consuming the captures

This repo does not include anything that reads the captured files — that's
deliberate. `captures/<date>.md` is plain markdown with a predictable line
shape, so anything can consume it:

- **Pull-on-wake**: a cron job, a login hook, or an agent's startup routine
  that does `git pull` on the target repo and reads whatever landed since
  last time. This is the pattern the author uses — no polling, no
  webhook-to-consumer, just "when I next look, it's there."
- **Obsidian**: point a vault at the repo (or a folder inside it) and sync
  with any git plugin. The files are just markdown.
- **A script or agent**: grep the file for `#tg` / `#share`, or anything you
  tag, and route lines wherever you want them to end up. `commitWithRetry` in
  `src/index.js` is a reasonable reference if you want to write into these
  files from another tool without racing this worker's own writes.

## Limitations, honestly

- **Single owner.** One Telegram user ID. Not built for a shared bot or a
  team inbox.
- **Text-shaped captures only.** No image storage, no attachment archival —
  photos and documents are described (caption/filename), not saved. The
  media itself stays in Telegram; only the reference to it is filed.
- **Transcription is optional and imperfect.** It uses Cloudflare's free
  Workers AI Whisper binding. Video files occasionally fail depending on
  container/codec; when transcription fails for any reason, the caption
  still gets filed as a stub, but the audio content itself is lost.
- **No editing or deletion lane.** This worker only appends. Fixing a bad
  capture means editing the file in git directly.
- **No offline queue.** If GitHub's API is down or rate-limited, the write
  fails and you get a Telegram reply saying so — nothing is silently
  retried after that reply.
- **20MB media cap**, inherited from the Telegram Bot API's file-download
  limit.
- **Optimistic-locked writes, not a queue.** Two captures landing in the
  same second both race for the same file `sha`; the loser retries against
  fresh content (see `commitWithRetry`), up to three attempts. It's built to
  survive a photo album, not sustained concurrent writers.

## Development

```
npm test           # node --test, no network, no credentials needed
npx wrangler dev    # run locally against real Telegram/GitHub if you export secrets to .dev.vars
```

`.dev.vars` (gitignored) can hold local secrets for `wrangler dev`; see
[Wrangler's docs](https://developers.cloudflare.com/workers/wrangler/) for
the format.

## License

MIT — see `LICENSE`.
