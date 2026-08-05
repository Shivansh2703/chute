// POST /capture — the token-protected share-sheet lane. Same filing path as a
// Telegram text capture, so these tests assert the auth gate, the body
// contract, and that what lands in the capture file is the identical
// log-line shape (only the lane tag differs).

import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { composeCaptureEntry, looksLikeCameraFilename } from '../src/index.js';
import { zonedParts } from '../src/lib/time.js';

const ENV = {
  BOT_TOKEN: 'bot-token',
  WEBHOOK_SECRET: 'hunter2',
  GITHUB_TOKEN: 'gh-token',
  GITHUB_REPO: 'example/vault',
  OWNER_ID: '111111111',
  CAPTURE_TOKEN: 'sekrit-capture-token',
};

const FILE = '# Captures — 2026-01-15\n\n';

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function stubFetch({ noteContent = FILE, putStatus = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    if (u.startsWith('https://api.github.com/') && (init.method || 'GET') === 'GET') {
      if (noteContent === null) return new Response(null, { status: 404 });
      return Response.json({ sha: 'deadbeef', content: b64(noteContent) });
    }
    if (u.startsWith('https://api.github.com/') && init.method === 'PUT') {
      if (putStatus !== 200) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: putStatus });
      }
      return Response.json({ commit: { sha: 'abc1234' } });
    }
    if (u.includes('/sendMessage')) {
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function capture(body, { token = ENV.CAPTURE_TOKEN, raw = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request('https://chute.example/capture', {
    method: 'POST',
    headers,
    body: raw === null ? JSON.stringify(body) : raw,
  });
}

function writtenNote(calls) {
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'expected a GitHub PUT');
  return Buffer.from(JSON.parse(put.body).content, 'base64').toString('utf8');
}

test('capture endpoint: a bad, missing, or unconfigured token is rejected without touching GitHub', async () => {
  const stub = stubFetch();
  try {
    for (const [label, req, env] of [
      ['wrong token', capture({ text: 'x' }, { token: 'nope' }), ENV],
      ['no header', capture({ text: 'x' }, { token: null }), ENV],
      ['empty bearer', capture({ text: 'x' }, { token: '' }), ENV],
      ['secret unset', capture({ text: 'x' }), { ...ENV, CAPTURE_TOKEN: undefined }],
      ['secret empty', capture({ text: 'x' }, { token: '' }), { ...ENV, CAPTURE_TOKEN: '' }],
    ]) {
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401, label);
    }
    assert.equal(stub.calls.length, 0, 'unauthorized traffic must never reach GitHub');
  } finally {
    stub.restore();
  }
});

test('capture endpoint: a paste-mangled secret still authenticates', async () => {
  const stub = stubFetch();
  try {
    const env = { ...ENV, CAPTURE_TOKEN: '" sekrit-capture-token "' };
    const res = await worker.fetch(capture({ text: 'paste artifact' }), env);
    assert.equal(res.status, 200);
  } finally {
    stub.restore();
  }
});

test('capture endpoint: a body with nothing fileable is a 400', async () => {
  const stub = stubFetch();
  try {
    for (const [label, req] of [
      ['no fields', capture({})],
      ['blank text', capture({ text: '   ' })],
      ['wrong types', capture({ text: 42, url: false })],
      ['array body', capture([{ text: 'x' }])],
      ['malformed json', capture(null, { raw: '{not json' })],
      ['non-http url', capture({ url: 'javascript:alert(1)' })],
    ]) {
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 400, label);
      assert.equal((await res.json()).filed, false, label);
    }
    assert.equal(stub.calls.length, 0, 'rejected bodies must never reach GitHub');
  } finally {
    stub.restore();
  }
});

test('capture endpoint: text-only files the same line shape as Telegram', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(capture({ text: 'ship the capture endpoint' }), ENV);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.filed, true, 'the caller success contract must not change');
    assert.match(json.time, /^\d{2}:\d{2}$/);

    const put = stub.calls.find((c) => c.method === 'PUT');
    assert.match(put.url, /captures\/\d{4}-\d{2}-\d{2}\.md$/, 'shares land in the same file');
    const note = writtenNote(stub.calls);
    assert.match(note, /- \*\*\d{2}:\d{2}\*\* — ship the capture endpoint #share/);
    assert.equal(JSON.parse(put.body).sha, 'deadbeef');
  } finally {
    stub.restore();
  }
});

test('capture endpoint: new lines append to the bottom of an existing file', async () => {
  const file = `${FILE}- **09:00** — earlier thing #share\n`;
  const stub = stubFetch({ noteContent: file });
  try {
    const res = await worker.fetch(capture({ text: 'later thing' }), ENV);
    assert.equal(res.status, 200);
    const note = writtenNote(stub.calls);
    assert.ok(note.indexOf('later thing') > note.indexOf('earlier thing'), 'newest at the bottom');
    assert.match(note, /^# Captures/, 'the header survives the append');
  } finally {
    stub.restore();
  }
});

test('capture endpoint: url-only files the bare url', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(capture({ url: 'https://example.com/post' }), ENV);
    assert.equal(res.status, 200);
    assert.match(writtenNote(stub.calls), /— https:\/\/example\.com\/post #share/);
  } finally {
    stub.restore();
  }
});

test('capture endpoint: text + url files a markdown link, newlines collapsed', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(
      capture({ text: 'A great\npost', url: 'https://example.com/post' }),
      ENV,
    );
    assert.equal(res.status, 200);
    assert.match(writtenNote(stub.calls), /— \[A great; post\]\(https:\/\/example\.com\/post\) #share/);
  } finally {
    stub.restore();
  }
});

test('capture endpoint: a missing capture file is created with its header', async () => {
  const stub = stubFetch({ noteContent: null });
  try {
    await worker.fetch(capture({ text: 'first of the day' }), ENV);
    const note = writtenNote(stub.calls);
    assert.match(note, /^# Captures — \d{4}-\d{2}-\d{2}\n/);
    assert.match(note, /first of the day #share/);
  } finally {
    stub.restore();
  }
});

test('capture endpoint: an identical line is reported as a duplicate, not written twice', async () => {
  // Seed this minute AND the next one so a clock roll mid-test can't decide
  // whether the line collides.
  const now = new Date();
  const seeded = [now, new Date(now.getTime() + 60_000)]
    .map((at) => {
      const { hh, mm } = zonedParts(at, 'UTC');
      return `- **${hh}:${mm}** — dedupe me #share`;
    })
    .join('\n');

  const stub = stubFetch({ noteContent: `${FILE}${seeded}\n` });
  try {
    const res = await worker.fetch(capture({ text: 'dedupe me' }), ENV);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.filed, true);
    assert.equal(json.duplicate, true);
    assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 0, 'no rewrite');
  } finally {
    stub.restore();
  }
});

test('capture endpoint: a GitHub failure surfaces as 502 with the reason', async () => {
  const stub = stubFetch({ putStatus: 401 });
  try {
    const res = await worker.fetch(capture({ text: 'will not land' }), ENV);
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.filed, false);
    assert.match(json.error, /401/);
  } finally {
    stub.restore();
  }
});

test('capture endpoint: other methods and paths are unchanged 404s', async () => {
  const stub = stubFetch();
  try {
    const get = await worker.fetch(new Request('https://chute.example/capture'), ENV);
    assert.equal(get.status, 404, 'GET /capture must not be a capture');
    const other = await worker.fetch(
      new Request('https://chute.example/nope', { method: 'POST' }),
      ENV,
    );
    assert.equal(other.status, 404);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('composeCaptureEntry: never emits a markdown link it would mangle', () => {
  assert.equal(composeCaptureEntry('title', 'https://e.com/a'), '[title](https://e.com/a)');
  assert.equal(composeCaptureEntry('note [1]', 'https://e.com'), 'note [1] — https://e.com');
  // a paren in the URL truncates the link target in most renderers
  assert.equal(
    composeCaptureEntry('Foo', 'https://en.wikipedia.org/wiki/Foo_(disambiguation)'),
    'Foo — https://en.wikipedia.org/wiki/Foo_(disambiguation)',
  );
  assert.equal(composeCaptureEntry('https://e.com', 'https://e.com'), 'https://e.com');
  assert.equal(composeCaptureEntry('plain', ''), 'plain');
});

test('capture endpoint: a parenthesised url is filed intact, not as a broken link', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(
      capture({ text: 'Foo', url: 'https://en.wikipedia.org/wiki/Foo_(disambiguation)' }),
      ENV,
    );
    assert.equal(res.status, 200);
    const note = writtenNote(stub.calls);
    assert.match(note, /— Foo — https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(disambiguation\) #share/);
    assert.ok(!note.includes('[Foo]('), 'must not emit a link the renderer would truncate');
  } finally {
    stub.restore();
  }
});

// ---- camera-roll filenames ----
//
// Sharing a photo from the library hands this lane the file's NAME and no
// URL. Filing `IMG_3534` reads like a success and is a dead line — the image
// never left the phone. Refuse it and say so.

test('composeCaptureEntry / looksLikeCameraFilename: filename shapes that must be refused', () => {
  for (const text of [
    'IMG_3534', 'IMG_3535.HEIC', 'img_0012.jpeg', 'IMG_0001 2.PNG',
    'DSC_0042', 'PXL_20260804_123456.mp4', 'RPReplay_Final.mov', 'FullSizeRender.jpg',
  ]) {
    assert.ok(looksLikeCameraFilename(text), `expected ${text} to look like a camera filename`);
  }
});

test('capture endpoint: a bare camera-roll filename is refused, not filed as a dead line', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(capture({ text: 'IMG_3534' }), ENV);
    assert.equal(res.status, 422);
    assert.equal(JSON.parse(await res.text()).filed, false);
    assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 0, 'nothing may be filed');

    const nudge = stub.calls.find((c) => c.url.includes('/sendMessage'));
    assert.ok(nudge, 'the owner must be told, not left guessing');
    const sent = JSON.parse(nudge.body);
    assert.equal(String(sent.chat_id), ENV.OWNER_ID);
    assert.match(sent.text, /IMG_3534/);
    assert.match(sent.text, /Telegram/);
  } finally {
    stub.restore();
  }
});

// The dangerous direction: a false positive would invent a brand-new loss.
test('capture endpoint: real captures are never mistaken for filenames', async () => {
  for (const body of [
    { text: 'IMG_3534', url: 'https://example.com/p/1' }, // a URL means it is a real share
    { text: 'gym' },
    { text: 'call mom 2' },
    { text: 'watch the .mov file he sent' },
    { text: 'img' },
    { text: 'screenshot the dashboard tomorrow' },
    { text: 'read Sapiens.pdf' },
    { text: 'IMG idea: photo wall for the flat' },
  ]) {
    const stub = stubFetch();
    try {
      const res = await worker.fetch(capture(body), ENV);
      assert.equal(res.status, 200, `expected ${JSON.stringify(body)} to be filed`);
      assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 1);
    } finally {
      stub.restore();
    }
  }
});

test('capture endpoint: an outage on the Telegram nudge cannot break the refusal', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/sendMessage')) throw new Error('telegram down');
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(capture({ text: 'IMG_9999' }), ENV);
    assert.equal(res.status, 422, 'the response must not depend on the nudge landing');
  } finally {
    globalThis.fetch = original;
  }
});

// The refusal is a data-loss guard; the Telegram nudge is only how the owner
// hears about it. Gating the guard on OWNER_ID being set would mean a deploy
// that uses the share lane alone silently files the dead line it exists to
// refuse.
test('capture endpoint: the filename refusal does not depend on OWNER_ID being set', async () => {
  for (const owner of [undefined, '']) {
    const stub = stubFetch();
    try {
      const res = await worker.fetch(capture({ text: 'IMG_3534' }), { ...ENV, OWNER_ID: owner });
      assert.equal(res.status, 422, `OWNER_ID=${JSON.stringify(owner)}`);
      assert.equal(JSON.parse(await res.text()).filed, false);
      assert.equal(
        stub.calls.filter((c) => c.method === 'PUT').length,
        0,
        'a dead filename line must never be filed, configured owner or not',
      );
      assert.equal(
        stub.calls.filter((c) => c.url.includes('/sendMessage')).length,
        0,
        'with no owner to reach, there is nobody to nudge',
      );
    } finally {
      stub.restore();
    }
  }
});

test('capture endpoint: configurable tags and directory are honored', async () => {
  const stub = stubFetch();
  try {
    const env = { ...ENV, SHARE_TAG: '#clip', CAPTURE_DIR: 'inbox' };
    const res = await worker.fetch(capture({ text: 'custom lane' }), env);
    assert.equal(res.status, 200);
    const put = stub.calls.find((c) => c.method === 'PUT');
    assert.match(put.url, /inbox\/\d{4}-\d{2}-\d{2}\.md$/);
    assert.match(writtenNote(stub.calls), /custom lane #clip/);
  } finally {
    stub.restore();
  }
});
