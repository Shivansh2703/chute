/**
 * chute — Telegram -> GitHub capture pipeline.
 *
 * Receives a Telegram webhook update, filters to the configured owner's own
 * messages, and appends a timestamped line to today's capture file
 * (`<CAPTURE_DIR>/<date>.md`, default `captures/<date>.md`) in a GitHub repo
 * via the Contents API. A second lane, `POST /capture`, files the same shape
 * of line from an HTTP POST (share sheet, Shortcuts, curl) so nothing has to
 * go through Telegram.
 *
 * No console.log of message text or tokens — only update_id and status words.
 */

import { envValue, secretEquals } from './lib/env.js';
import { githubGetFile, githubPutFile } from './lib/github.js';
import { DEFAULT_TIMEZONE, zonedParts } from './lib/time.js';

const DEFAULT_CAPTURE_DIR = 'captures';
const DEFAULT_TG_TAG = '#tg';
const DEFAULT_SHARE_TAG = '#share';

function captureDir(env) {
  return envValue(env, 'CAPTURE_DIR') || DEFAULT_CAPTURE_DIR;
}

function timeZone(env) {
  return envValue(env, 'CAPTURE_TZ') || DEFAULT_TIMEZONE;
}

function tag(env, name, fallback) {
  return envValue(env, name) || fallback;
}

function capturePath(dateStr, env) {
  return `${captureDir(env)}/${dateStr}.md`;
}

// Base64-encode raw bytes (an ArrayBuffer/Uint8Array), chunk-wise — building
// the binary string in one shot via String.fromCharCode(...bigArray) blows
// the call stack on anything past a few tens of KB.
const B64_CHUNK = 32768;
function b64encodeBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

// ---- Telegram reply ----

async function tgSendMessage(chatId, text, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram API request failed: HTTP ${res.status}`);
}

async function tgReply(chatId, text, env) {
  try {
    await tgSendMessage(chatId, text, env);
  } catch {
    // a failed reply must never crash the handler
  }
}

// ---- media / transcription ----

// Telegram bot-API hard cap on file downloads via getFile.
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

// message field -> [log-line kind label, lane], in lookup order. `transcribe`
// kinds are downloaded and run through Whisper (only when a Workers AI
// binding is configured — see README); `describe` kinds have nothing to
// transcribe and are filed from the message metadata alone. Refusing the
// describe kinds is how a photo or shared reel would quietly vanish — a
// capture the worker cannot read is still a capture, so it always leaves a
// line. `animation` MUST come before `document`: Telegram sets both fields on
// a GIF.
const MEDIA_FIELDS = [
  ['voice', 'voice', 'transcribe'],
  ['video_note', 'video', 'transcribe'],
  ['video', 'video', 'transcribe'],
  ['audio', 'audio', 'transcribe'],
  ['animation', 'gif', 'describe'],
  ['photo', 'photo', 'describe'],
  ['sticker', 'sticker', 'describe'],
  ['document', 'document', 'describe'],
];

export function detectMedia(message) {
  for (const [field, kind, lane] of MEDIA_FIELDS) {
    const value = message[field];
    if (!value) continue;
    // photo arrives as an array of sizes, largest last
    const media = Array.isArray(value) ? value[value.length - 1] : value;
    if (media) return { kind, lane, media };
  }
  return null;
}

async function tgGetFile(fileId, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.ok) {
    const desc = json && json.description ? json.description : `getFile HTTP ${res.status}`;
    throw new Error(desc);
  }
  return json.result; // { file_id, file_path, file_size }
}

async function tgDownloadFile(filePath, env) {
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  return res.arrayBuffer();
}

// Transcription is optional: it only runs when the Worker has a Workers AI
// binding named `AI` (see wrangler.toml.example). Without it, voice/video/
// audio messages are filed as stubs, same as any other unreadable media.
async function transcribeAudio(buffer, env) {
  const audio = b64encodeBytes(buffer);
  const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio });
  return (result && result.text) || '';
}

// Shorten a thrown error (GithubError or plain Error/network failure) to a
// reply-safe string, same shape used by both the text and media paths.
function formatError(e) {
  if (typeof e.status === 'number') return `${e.status} ${e.short}`;
  if (typeof e.message === 'string') return e.message.substring(0, 120);
  return 'network error';
}

// ---- message filing ----

// The Contents API is optimistic-locked on the blob sha, and two captures
// landing in the same second (e.g. a photo album arrives as several
// concurrent webhooks) both read the same sha — the loser would take a 409
// and that line would never be written at all. Re-read and re-run the
// transform instead: the retry sees the winner's content, so its dedupe
// check accounts for the line that just landed.
const CONFLICT_STATUSES = [409, 422];
const COMMIT_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// transform(existingContent | null) -> new content, or null to skip the write.
// Throws GithubError on API failure; caller decides how to phrase the reply.
async function commitWithRetry(filePath, transform, message, env) {
  for (let attempt = 1; ; attempt++) {
    const fileInfo = await githubGetFile(filePath, env);
    const updated = transform(fileInfo.exists ? fileInfo.content : null);
    if (updated === null) return 'duplicate';
    try {
      const sha = fileInfo.exists ? fileInfo.sha : undefined;
      await githubPutFile(filePath, updated, sha, message, env);
      return 'written';
    } catch (e) {
      if (attempt >= COMMIT_ATTEMPTS || !CONFLICT_STATUSES.includes(e.status)) throw e;
      console.log('status', 'commit_conflict_retry');
      await sleep(150 * attempt);
    }
  }
}

function buildFileTemplate(dateStr) {
  return `# Captures — ${dateStr}\n\n`;
}

// Appended newest-at-bottom: `- **HH:MM** — entry #tag`.
async function fileLine(logLine, dateStr, env) {
  return commitWithRetry(
    capturePath(dateStr, env),
    (existing) => {
      const content = existing === null ? buildFileTemplate(dateStr) : existing;
      if (content.includes(logLine)) return null;
      // Normalising the tail to one newline keeps bullets contiguous, but it
      // also eats the blank line under the header, leaving the first capture
      // stuck to the comment block. Put that one gap back — only when there is
      // no bullet yet, so later appends stay tight against each other.
      const body = content.replace(/\n*$/, '\n');
      const gap = /^- /m.test(body) ? '' : '\n';
      return `${body}${gap}${logLine}\n`;
    },
    `capture: ${dateStr}`,
    env,
  );
}

// The shared tail of every capture lane: stamp the entry with the configured
// clock, drop it in today's file, and hand back what the caller needs to
// phrase its reply. `entryTag` marks which lane it came in on (`#tg` or
// `#share` by default, both configurable).
async function fileEntry(entryText, env, entryTag) {
  const { y, m, d, hh, mm } = zonedParts(new Date(), timeZone(env));
  const dateStr = `${y}-${m}-${d}`;
  const logLine = `- **${hh}:${mm}** — ${entryText} ${entryTag}`;
  try {
    const result = await fileLine(logLine, dateStr, env);
    return { ok: true, time: `${hh}:${mm}`, duplicate: result === 'duplicate' };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

// `filed ✓ 14:32 (photo)` / `filed ✓ 14:32 (already there)` / the ⚠️ failure.
async function replyFiled(res, label, chatId, env) {
  if (!res.ok) {
    await tgReply(chatId, `⚠️ capture NOT filed: ${res.error}`, env);
    return;
  }
  let suffix = '';
  if (res.duplicate) suffix = ' (already there)';
  else if (label) suffix = ` (${label})`;
  await tgReply(chatId, `filed ✓ ${res.time}${suffix}`, env);
}

async function handleTextMessage(message, chatId, env) {
  const trimmed = message.text.trim();
  const entry = trimmed.replace(/^capture:\s*/i, '').trim();
  if (!entry) {
    await tgReply(chatId, 'empty capture — nothing filed', env);
    return;
  }
  const entryText = entry.replace(/\r\n|\r|\n/g, '; ');
  await replyFiled(await fileEntry(entryText, env, tag(env, 'TG_TAG', DEFAULT_TG_TAG)), '', chatId, env);
}

// A capture that reached the worker must leave a line in the file, even when
// a transcript can't be produced: the bytes are gone either way, but the fact
// that something arrived — and its caption, which is often where a shared
// link lives — is what would otherwise go missing. `note` says why there is
// no transcript; the reply says so in plain words.
async function fileMediaStub({ kind, caption, note, reason, chatId, env }) {
  const entry = caption ? `(${kind}, ${note}) ${caption}` : `(${kind}, ${note})`;
  const res = await fileEntry(entry, env, tag(env, 'TG_TAG', DEFAULT_TG_TAG));
  if (!res.ok) {
    await tgReply(chatId, `⚠️ capture NOT filed: ${res.error}`, env);
    return;
  }
  const suffix = res.duplicate ? ' (already there)' : '';
  await tgReply(chatId, `${reason} — filed as a stub ✓ ${res.time}${suffix}`, env);
}

// Voice/video-note/video/audio: getFile -> size check -> download -> Workers
// AI transcription (if configured) -> file the transcript through the same
// pipeline as text. Media bytes are never persisted anywhere — only the
// transcript is filed.
async function handleMediaMessage(kind, media, message, chatId, env) {
  const caption = collapse(message.caption || '');
  const stub = (note, reason) => fileMediaStub({ kind, caption, note, reason, chatId, env });

  if (!env.AI) {
    await stub('not transcribed, no AI binding configured', 'no transcription configured');
    return;
  }

  let fileMeta;
  try {
    fileMeta = await tgGetFile(media.file_id, env);
  } catch (e) {
    await stub('not transcribed', `⚠️ ${formatError(e)}`);
    return;
  }

  if (typeof fileMeta.file_size === 'number' && fileMeta.file_size > MEDIA_MAX_BYTES) {
    await stub('too large to transcribe', 'media too big to transcribe (>20MB)');
    return;
  }

  let bytes;
  try {
    bytes = await tgDownloadFile(fileMeta.file_path, env);
  } catch (e) {
    await stub('not transcribed', `⚠️ ${formatError(e)}`);
    return;
  }

  let transcript;
  try {
    transcript = await transcribeAudio(bytes, env);
  } catch (e) {
    await stub('not transcribed', `⚠️ ${formatError(e)}`);
    return;
  }

  const collapsed = collapse(transcript || '');
  if (!collapsed) {
    // Silent clip — a music-only reel is the everyday case. The caption still
    // carries the link, so it is filed on its own rather than thrown away.
    if (caption) {
      await replyFiled(
        await fileEntry(`(${kind}) ${caption}`, env, tag(env, 'TG_TAG', DEFAULT_TG_TAG)),
        `${kind}, no speech`,
        chatId,
        env,
      );
    } else {
      await stub('no speech', 'nothing to transcribe');
    }
    return;
  }

  const body = caption ? `${caption} — ${collapsed}` : collapsed;
  await replyFiled(
    await fileEntry(`(${kind}) ${body}`, env, tag(env, 'TG_TAG', DEFAULT_TG_TAG)),
    `${kind}, transcribed`,
    chatId,
    env,
  );
}

// Photos, GIFs, stickers and documents: nothing to download and nothing to
// transcribe, so the line is built from the message metadata alone.
export function describeEntry(kind, media, message) {
  const caption = collapse(message.caption || '');
  if (kind === 'sticker') {
    const emoji = collapse(media.emoji || '');
    return emoji ? `(sticker) ${emoji}` : '(sticker)';
  }
  if (kind === 'document') {
    const name = collapse(media.file_name || '') || 'file';
    return caption ? `(document) ${name} — ${caption}` : `(document) ${name}`;
  }
  return `(${kind}) ${caption || 'no caption'}`;
}

async function handleDescribeMessage(kind, media, message, chatId, env) {
  const res = await fileEntry(describeEntry(kind, media, message), env, tag(env, 'TG_TAG', DEFAULT_TG_TAG));
  await replyFiled(res, kind, chatId, env);
}

async function handleMessage(message, chatId, env) {
  const media = detectMedia(message);
  if (media) {
    const handler = media.lane === 'describe' ? handleDescribeMessage : handleMediaMessage;
    await handler(media.kind, media.media, message, chatId, env);
    return;
  }

  if (typeof message.text !== 'string') {
    // What's left is location, contact, poll, dice and friends — no text to
    // file yet.
    await tgReply(
      chatId,
      "that message type isn't filed yet — text, links, photos, files, stickers, voice and video all work",
      env,
    );
    return;
  }

  await handleTextMessage(message, chatId, env);
}

// ---- HTTP capture lane (POST /capture) ----
//
// The share-sheet / Siri / Action-Button / curl lane: a token-protected JSON
// POST that files through the EXACT same path as a Telegram text capture.
// Bounded on purpose — text and url only; photos, files and voice stay on
// the Telegram lane.

function collapse(value) {
  return String(value).trim().replace(/\r\n|\r|\n/g, '; ');
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// text + url -> markdown link; either alone -> itself. Brackets in the text or
// parens/spaces in the url would break the link syntax (Wikipedia's
// `..._(disambiguation)` is the everyday case), and a share sheet often hands
// over the URL as the "text" too — all of those fall back to a plain joined
// line, which renders fine and never mangles the address.
export function composeCaptureEntry(text, url) {
  if (!url) return text;
  if (!text || text === url) return url;
  if (/[[\]()]/.test(text) || /[()\s]/.test(url)) return `${text} — ${url}`;
  return `[${text}](${url})`;
}

// Sharing a camera-roll photo hands this lane the FILE'S NAME and no URL —
// there is nothing else to send, since the image never leaves the phone.
// Filing `IMG_3534` looks like a successful capture and is really a dead
// line. Refusing it and saying so out loud turns a silent loss into a nudge
// to send the photo over Telegram, where it is filed properly.
//
// Deliberately narrow: a false positive here would invent a NEW loss, so this
// only fires on a single whitespace-free token that is either a media
// filename or a camera-roll stem, and never when a URL came along with it.
const MEDIA_EXTENSION_RE = /\.(jpe?g|png|heic|heif|gif|mov|mp4|m4v|webp|tiff?|dng|aae|hevc)$/i;
const CAMERA_STEM_RE = /^(img|image|dsc|dscn|pxl|mvimg|pano|vid|rpreplay|fullsizerender|screenshot)[-_]?\d{3,}$/i;

export function looksLikeCameraFilename(text) {
  // iOS numbers a duplicate `IMG_0001 2.PNG`; fold that back before matching.
  const token = text.trim().replace(/ \d+(\.\w+)?$/, '$1');
  if (!token || /\s/.test(token)) return false;
  return MEDIA_EXTENSION_RE.test(token) || CAMERA_STEM_RE.test(token);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleCaptureRequest(request, env) {
  const expected = envValue(env, 'CAPTURE_TOKEN');
  const header = request.headers.get('Authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // No token configured means the lane is closed, not open to everyone.
  if (!expected || !presented || !(await secretEquals(presented, expected))) {
    console.log('status', 'capture_unauthorized');
    return new Response(null, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ filed: false, error: 'body must be JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ filed: false, error: 'body must be a JSON object' }, 400);
  }

  const text = typeof body.text === 'string' ? collapse(body.text) : '';
  const url = typeof body.url === 'string' ? collapse(body.url) : '';
  if (!text && !url) {
    return jsonResponse({ filed: false, error: 'text or url required' }, 400);
  }
  if (url && !isHttpUrl(url)) {
    return jsonResponse({ filed: false, error: 'url must be http(s)' }, 400);
  }
  if (!url && looksLikeCameraFilename(text) && env.OWNER_ID) {
    console.log('status', 'capture_filename_refused');
    // Told over Telegram as well as in the response: whether the caller
    // surfaces an error is not something this worker can rely on.
    await tgReply(
      env.OWNER_ID,
      `that arrived as a filename (${text}) — the photo itself stayed on your phone, so nothing was filed. Send it over Telegram and it goes in properly.`,
      env,
    );
    return jsonResponse(
      { filed: false, error: 'looks like a photo filename, not a capture — send the photo over Telegram' },
      422,
    );
  }

  // Same file as the Telegram lane — a share is a dump too. The `#share` tag
  // is what keeps the two lanes tellable apart afterwards.
  const res = await fileEntry(composeCaptureEntry(text, url), env, tag(env, 'SHARE_TAG', DEFAULT_SHARE_TAG));
  if (!res.ok) {
    console.log('status', 'capture_error');
    return jsonResponse({ filed: false, error: res.error }, 502);
  }
  console.log('status', res.duplicate ? 'capture_duplicate' : 'capture_filed');
  const payload = { filed: true, time: res.time };
  if (res.duplicate) payload.duplicate = true;
  return jsonResponse(payload, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/capture') {
      return handleCaptureRequest(request, env);
    }
    if (request.method !== 'POST' || url.pathname !== '/telegram') {
      return new Response(null, { status: 404 });
    }

    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response(null, { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      // malformed body — still ack so Telegram stops retrying
      return new Response('ok', { status: 200 });
    }
    console.log('update_id', update.update_id);

    const message = update.message;
    if (!message) {
      return new Response('ok', { status: 200 });
    }

    const fromId = message.from && message.from.id;
    if (Number(fromId) !== Number(env.OWNER_ID)) {
      // silently drop strangers — no reply, no logging of their content
      return new Response('ok', { status: 200 });
    }

    const chatId = message.chat?.id;
    if (chatId === undefined) {
      return new Response('ok', { status: 200 });
    }
    try {
      await handleMessage(message, chatId, env);
      console.log('status', 'handled_ok');
    } catch (e) {
      console.log('status', 'handler_error');
      await tgReply(chatId, '⚠️ capture NOT filed: internal error', env);
    }

    // Always 200 to Telegram once auth passes — failures are reported via reply.
    return new Response('ok', { status: 200 });
  },
};
