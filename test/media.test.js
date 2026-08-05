// Media capture lanes, end-to-end through the real `fetch` handler.
//
// The rule these tests hold: anything that reaches the worker leaves a line
// in the capture file — refusing a photo or letting a silent video vanish
// with no trace is a bug, not a graceful failure.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const ENV = {
  BOT_TOKEN: 'bot-token',
  WEBHOOK_SECRET: 'hunter2',
  GITHUB_TOKEN: 'gh-token',
  GITHUB_REPO: 'example/vault',
  OWNER_ID: '111111111',
  AI: { run: async () => ({ text: 'the transcript' }) },
};

const FILE = '# Captures — 2026-01-15\n\n';

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * Stubs GitHub, Telegram getFile/download and sendMessage.
 * `fileSize` drives the 20MB gate; `failAt` forces one leg to throw.
 */
function stubFetch({ fileSize = 1024, failAt = null } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });

    if (u.startsWith('https://api.github.com/') && (init.method || 'GET') === 'GET') {
      return Response.json({ sha: 'deadbeef', content: b64(FILE) });
    }
    if (u.startsWith('https://api.github.com/') && init.method === 'PUT') {
      return Response.json({ commit: { sha: 'abc1234' } });
    }
    if (u.includes('/getFile')) {
      if (failAt === 'getFile') return new Response(JSON.stringify({ ok: false, description: 'file is gone' }), { status: 400 });
      return Response.json({ ok: true, result: { file_id: 'f1', file_path: 'voice/f1.oga', file_size: fileSize } });
    }
    if (u.startsWith('https://api.telegram.org/file/')) {
      if (failAt === 'download') return new Response(null, { status: 502 });
      return new Response(new ArrayBuffer(64));
    }
    if (u.includes('/sendMessage')) {
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return {
    calls,
    puts: () => calls.filter((c) => c.method === 'PUT' && c.url.startsWith('https://api.github.com/')),
    replies: () => calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.body).text),
    written: () => Buffer.from(JSON.parse(calls.find((c) => c.method === 'PUT').body).content, 'base64').toString('utf8'),
    restore() {
      globalThis.fetch = original;
    },
  };
}

function post(messageFields) {
  const message = { message_id: 7, from: { id: 111111111 }, chat: { id: 111111111 }, ...messageFields };
  return new Request('https://chute.example/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'hunter2' },
    body: JSON.stringify({ update_id: 1, message }),
  });
}

// The filed log line, without the timestamp stamp.
function entryOf(stub) {
  const line = stub.written().split('\n').find((l) => l.includes('#tg'));
  assert.ok(line, 'expected a #tg log line in the written file');
  return line.replace(/^- \*\*\d{2}:\d{2}\*\* — /, '').replace(/ #tg$/, '');
}

// ---- describe lane: nothing to download, nothing to transcribe ----

test('media: a photo with a caption is filed, not refused', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(post({ photo: [{ file_id: 'small' }, { file_id: 'large' }], caption: 'this reel https://example.com/p/1' }), ENV);
    assert.equal(res.status, 200);
    assert.equal(entryOf(stub), '(photo) this reel https://example.com/p/1');
    assert.match(stub.replies()[0], /filed ✓ \d{2}:\d{2} \(photo\)/);
    assert.equal(stub.calls.filter((c) => c.url.includes('/getFile')).length, 0, 'describe lane must not download');
  } finally {
    stub.restore();
  }
});

test('media: a captionless photo still files a line', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post({ photo: [{ file_id: 'x' }] }), ENV);
    assert.equal(entryOf(stub), '(photo) no caption');
    assert.match(stub.puts()[0].url, /captures\/\d{4}-\d{2}-\d{2}\.md$/, 'lands in the capture file');
  } finally {
    stub.restore();
  }
});

test('media: a document is filed with its filename and caption', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post({ document: { file_id: 'd1', file_name: 'lease.pdf' }, caption: 'sign by friday' }), ENV);
    assert.equal(entryOf(stub), '(document) lease.pdf — sign by friday');
  } finally {
    stub.restore();
  }
});

test('media: a document without a caption keeps just the filename', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post({ document: { file_id: 'd1', file_name: 'lease.pdf' } }), ENV);
    assert.equal(entryOf(stub), '(document) lease.pdf');
  } finally {
    stub.restore();
  }
});

test('media: a sticker files its emoji', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post({ sticker: { file_id: 's1', emoji: '🔥' } }), ENV);
    assert.equal(entryOf(stub), '(sticker) 🔥');
  } finally {
    stub.restore();
  }
});

test('media: a GIF files as (gif), not as the document Telegram also attaches', async () => {
  const stub = stubFetch();
  try {
    // Telegram sets BOTH fields on an animation — lookup order decides.
    await worker.fetch(post({
      animation: { file_id: 'a1', file_name: 'giphy.mp4' },
      document: { file_id: 'a1', file_name: 'giphy.mp4' },
      caption: 'this one',
    }), ENV);
    assert.equal(entryOf(stub), '(gif) this one');
  } finally {
    stub.restore();
  }
});

test('media: an empty photo array falls through instead of crashing', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(post({ photo: [] }), ENV);
    assert.equal(res.status, 200);
    assert.equal(stub.puts().length, 0);
    assert.match(stub.replies()[0], /isn't filed yet/);
  } finally {
    stub.restore();
  }
});

// ---- transcribe lane: a stub whenever the transcript can't be produced ----

test('media: a voice note still files its transcript', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post({ voice: { file_id: 'v1' } }), ENV);
    assert.equal(entryOf(stub), '(voice) the transcript');
    assert.match(stub.replies()[0], /filed ✓ \d{2}:\d{2} \(voice, transcribed\)/);
  } finally {
    stub.restore();
  }
});

test('media: a caption is prepended to the transcript', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post({ video: { file_id: 'v1' }, caption: 'watch from 0:30' }), ENV);
    assert.equal(entryOf(stub), '(video) watch from 0:30 — the transcript');
  } finally {
    stub.restore();
  }
});

test('media: no AI binding files a stub instead of erroring', async () => {
  const stub = stubFetch();
  const env = { ...ENV, AI: undefined };
  try {
    await worker.fetch(post({ voice: { file_id: 'v1' }, caption: 'no ai here' }), env);
    assert.equal(entryOf(stub), '(voice, not transcribed, no AI binding configured) no ai here');
    assert.match(stub.replies()[0], /no transcription configured — filed as a stub ✓/);
  } finally {
    stub.restore();
  }
});

test('media: oversized media files a stub instead of vanishing', async () => {
  const stub = stubFetch({ fileSize: 21 * 1024 * 1024 });
  try {
    await worker.fetch(post({ video: { file_id: 'v1' }, caption: 'the long one' }), ENV);
    assert.equal(entryOf(stub), '(video, too large to transcribe) the long one');
    assert.match(stub.replies()[0], /too big to transcribe \(>20MB\) — filed as a stub ✓/);
  } finally {
    stub.restore();
  }
});

test('media: a silent clip files its caption rather than dropping the capture', async () => {
  const stub = stubFetch();
  try {
    const env = { ...ENV, AI: { run: async () => ({ text: '   ' }) } };
    await worker.fetch(post({ video: { file_id: 'v1' }, caption: 'reel https://example.com/p/2' }), env);
    assert.equal(entryOf(stub), '(video) reel https://example.com/p/2');
    assert.match(stub.replies()[0], /no speech/);
  } finally {
    stub.restore();
  }
});

test('media: a silent clip with no caption files a stub', async () => {
  const stub = stubFetch();
  try {
    const env = { ...ENV, AI: { run: async () => ({ text: '' }) } };
    await worker.fetch(post({ video_note: { file_id: 'v1' } }), env);
    assert.equal(entryOf(stub), '(video, no speech)');
    assert.match(stub.replies()[0], /nothing to transcribe — filed as a stub ✓/);
  } finally {
    stub.restore();
  }
});

test('media: a transcription failure files a stub AND says so', async () => {
  const stub = stubFetch();
  try {
    const env = { ...ENV, AI: { run: async () => { throw new Error('whisper exploded'); } } };
    await worker.fetch(post({ voice: { file_id: 'v1' }, caption: 'the important bit' }), env);
    assert.equal(entryOf(stub), '(voice, not transcribed) the important bit');
    const reply = stub.replies()[0];
    assert.match(reply, /⚠️ whisper exploded/);
    assert.match(reply, /filed as a stub ✓/);
  } finally {
    stub.restore();
  }
});

test('media: a getFile failure files a stub', async () => {
  const stub = stubFetch({ failAt: 'getFile' });
  try {
    await worker.fetch(post({ voice: { file_id: 'v1' } }), ENV);
    assert.equal(entryOf(stub), '(voice, not transcribed)');
    assert.match(stub.replies()[0], /filed as a stub ✓/);
  } finally {
    stub.restore();
  }
});

test('media: a download failure files a stub', async () => {
  const stub = stubFetch({ failAt: 'download' });
  try {
    await worker.fetch(post({ audio: { file_id: 'a1' }, caption: 'podcast bit' }), ENV);
    assert.equal(entryOf(stub), '(audio, not transcribed) podcast bit');
    assert.match(stub.replies()[0], /filed as a stub ✓/);
  } finally {
    stub.restore();
  }
});
