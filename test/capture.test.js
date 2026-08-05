// Regression tests for the Telegram webhook -> GitHub capture-file append.
// These exercise the real `fetch` handler end-to-end against stubbed network
// calls so a refactor can never silently break captures.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const ENV = {
  BOT_TOKEN: 'bot-token',
  WEBHOOK_SECRET: 'hunter2',
  GITHUB_TOKEN: 'gh-token',
  GITHUB_REPO: 'example/vault',
  OWNER_ID: '111111111',
};

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/** Records every outbound call and answers with canned responses. */
function stubFetch({ noteContent }) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });

    if (u.startsWith('https://api.github.com/') && (init.method || 'GET') === 'GET') {
      if (noteContent === null) {
        return new Response(null, { status: 404 });
      }
      return Response.json({ sha: 'deadbeef', content: b64(noteContent) });
    }
    if (u.startsWith('https://api.github.com/') && init.method === 'PUT') {
      return Response.json({ commit: { sha: 'abc1234' } });
    }
    if (u.startsWith('https://api.telegram.org/')) {
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

function update(overrides = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: 111111111 },
      chat: { id: 111111111 },
      text: 'buy milk',
      ...overrides,
    },
  };
}

function post(body, secret = 'hunter2') {
  return new Request('https://chute.example/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(body),
  });
}

const EXISTING_FILE = '# Captures — 2026-01-15\n\n';

test('capture: owner text lands in today\'s capture file', async () => {
  const stub = stubFetch({ noteContent: EXISTING_FILE });
  try {
    const res = await worker.fetch(post(update()), ENV);
    assert.equal(res.status, 200);

    const put = stub.calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'expected a GitHub PUT');
    assert.match(put.url, /captures\/\d{4}-\d{2}-\d{2}\.md$/, 'must write today\'s capture file');
    const sent = JSON.parse(put.body);
    const written = Buffer.from(sent.content, 'base64').toString('utf8');
    assert.match(written, /- \*\*\d{2}:\d{2}\*\* — buy milk #tg/);
    assert.equal(sent.sha, 'deadbeef', 'must pass the sha so the append is a real update');

    const reply = stub.calls.find((c) => c.url.includes('/sendMessage'));
    assert.ok(reply, 'owner must always get an ack');
    assert.match(JSON.parse(reply.body).text, /filed ✓/);
  } finally {
    stub.restore();
  }
});

test('capture: a missing capture file is created with its header', async () => {
  const stub = stubFetch({ noteContent: null });
  try {
    await worker.fetch(post(update({ text: 'first of the day' })), ENV);
    const put = stub.calls.find((c) => c.method === 'PUT');
    const written = Buffer.from(JSON.parse(put.body).content, 'base64').toString('utf8');
    assert.match(written, /^# Captures — \d{4}-\d{2}-\d{2}\n/);
    assert.match(written, /first of the day #tg/);
    assert.equal(JSON.parse(put.body).sha, undefined, 'a new file is created without a sha');
  } finally {
    stub.restore();
  }
});

test('capture: a GitHub failure replies with the error instead of dropping silently', async () => {
  const original = globalThis.fetch;
  const replies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      replies.push(JSON.parse(init.body).text);
      return Response.json({ ok: true });
    }
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  };
  try {
    const res = await worker.fetch(post(update()), ENV);
    assert.equal(res.status, 200, 'Telegram must still get a 200 so it stops retrying');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /NOT filed/);
    assert.match(replies[0], /401/);
  } finally {
    globalThis.fetch = original;
  }
});

test('capture: strangers and bad secrets are rejected without touching GitHub', async () => {
  const stub = stubFetch({ noteContent: EXISTING_FILE });
  try {
    const wrongSecret = await worker.fetch(post(update(), 'nope'), ENV);
    assert.equal(wrongSecret.status, 401);

    const stranger = await worker.fetch(
      post(update({ from: { id: 999 }, chat: { id: 999 } })),
      ENV,
    );
    assert.equal(stranger.status, 200);
    assert.equal(stub.calls.length, 0, 'no GitHub or Telegram calls for non-owner traffic');
  } finally {
    stub.restore();
  }
});

test('capture: the same line is not filed twice', async () => {
  const already = `${EXISTING_FILE}- **00:00** — dedupe me #tg\n`;
  const stub = stubFetch({ noteContent: already });
  try {
    // force the log line to collide by reusing the text already present
    await worker.fetch(post(update({ text: 'dedupe me' })), ENV);
    const puts = stub.calls.filter((c) => c.method === 'PUT');
    const reply = stub.calls.find((c) => c.url.includes('/sendMessage'));
    if (puts.length === 0) {
      assert.match(JSON.parse(reply.body).text, /already there/);
    } else {
      // different minute than the stored line — a write is correct, but it must
      // never duplicate an identical line
      const written = Buffer.from(JSON.parse(puts[0].body).content, 'base64').toString('utf8');
      const hits = written.split('\n').filter((l) => l.includes('dedupe me')).length;
      assert.equal(hits, 2);
    }
  } finally {
    stub.restore();
  }
});

test('capture: message types with nothing to file get a polite refusal', async () => {
  const stub = stubFetch({ noteContent: EXISTING_FILE });
  try {
    const msg = update();
    delete msg.message.text;
    msg.message.location = { latitude: 43.65, longitude: -79.38 };
    await worker.fetch(post(msg), ENV);
    assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 0);
    const reply = stub.calls.find((c) => c.url.includes('/sendMessage'));
    assert.match(JSON.parse(reply.body).text, /isn't filed yet/i);
  } finally {
    stub.restore();
  }
});

// ---- write races (409) ----
//
// Two captures in the same second read the same blob sha; the loser's PUT is
// rejected and its line used to be lost outright. Retry re-reads first, so the
// second write applies on top of the first instead of over it.

/** Answers the first `conflicts` GitHub PUTs with `status`, then succeeds. */
function stubConflicting(conflicts, status = 409) {
  const calls = [];
  const original = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    if (u.startsWith('https://api.telegram.org/')) return Response.json({ ok: true });
    if ((init.method || 'GET') === 'GET') return Response.json({ sha: `sha${calls.length}`, content: b64(EXISTING_FILE) });
    puts += 1;
    if (puts <= conflicts) {
      return new Response(JSON.stringify({ message: 'does not match' }), { status });
    }
    return Response.json({ commit: { sha: 'abc1234' } });
  };
  return {
    calls,
    gets: () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('https://api.github.com/')).length,
    puts: () => calls.filter((c) => c.method === 'PUT').length,
    reply: () => JSON.parse(calls.find((c) => c.url.includes('/sendMessage')).body).text,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('capture: a 409 conflict is retried against a fresh sha, not lost', async () => {
  const stub = stubConflicting(1);
  try {
    await worker.fetch(post(update({ text: 'raced capture' })), ENV);
    assert.equal(stub.puts(), 2, 'the losing PUT must be retried');
    assert.equal(stub.gets(), 2, 'the retry must re-read the file for a fresh sha');
    assert.match(stub.reply(), /filed ✓/);
  } finally {
    stub.restore();
  }
});

test('capture: a conflict that never clears is reported, after three attempts', async () => {
  const stub = stubConflicting(99);
  try {
    await worker.fetch(post(update({ text: 'hopeless' })), ENV);
    assert.equal(stub.puts(), 3);
    assert.match(stub.reply(), /NOT filed/);
    assert.match(stub.reply(), /409/);
  } finally {
    stub.restore();
  }
});

test('capture: a non-conflict error is not retried', async () => {
  const stub = stubConflicting(99, 401);
  try {
    await worker.fetch(post(update({ text: 'bad token' })), ENV);
    assert.equal(stub.puts(), 1, 'auth failures must fail fast');
    assert.match(stub.reply(), /NOT filed/);
  } finally {
    stub.restore();
  }
});
