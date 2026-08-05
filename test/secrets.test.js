// Paste-artifact tolerance, across every secret and id the worker reads.
//
// Secrets arrive by pasting into `wrangler secret put`, and a paste that
// carries a trailing newline or wrapping quotes is the single most likely
// setup mistake. `envValue` exists to absorb exactly that (see
// src/lib/env.js), and the /capture lane already proves it — these tests hold
// every other lane to the same promise, because the failure modes are silent:
// a mangled WEBHOOK_SECRET 401s every webhook forever with no reply, and a
// mangled OWNER_ID drops the owner's own messages as a stranger's.

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

const FILE = '# Captures — 2026-01-15\n\n';

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body, headers: init.headers });
    if (u.startsWith('https://api.github.com/') && (init.method || 'GET') === 'GET') {
      return Response.json({ sha: 'deadbeef', content: b64(FILE) });
    }
    if (u.startsWith('https://api.github.com/') && init.method === 'PUT') {
      return Response.json({ commit: { sha: 'abc1234' } });
    }
    if (u.includes('/sendMessage')) return Response.json({ ok: true });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return {
    calls,
    put() {
      return calls.find((c) => c.method === 'PUT');
    },
    restore() {
      globalThis.fetch = original;
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

// Every shape a paste can arrive in. Telegram sends the secret back exactly as
// registered, so the mangling is always on the stored side.
const MANGLED = ['"hunter2"', "'hunter2'", ' hunter2 ', 'hunter2\n', '" hunter2 "'];

test('webhook secret: a paste-mangled WEBHOOK_SECRET still authenticates', async () => {
  for (const stored of MANGLED) {
    const stub = stubFetch();
    try {
      const res = await worker.fetch(post(update()), { ...ENV, WEBHOOK_SECRET: stored });
      assert.equal(res.status, 200, `stored as ${JSON.stringify(stored)}`);
      assert.ok(stub.put(), `a capture must actually be filed, stored as ${JSON.stringify(stored)}`);
    } finally {
      stub.restore();
    }
  }
});

// The guard must not swing the other way: a genuinely wrong secret still 401s.
test('webhook secret: trimming does not let a wrong secret through', async () => {
  const stub = stubFetch();
  try {
    for (const presented of ['nope', '', 'hunter', 'hunter22']) {
      const res = await worker.fetch(post(update(), presented), ENV);
      assert.equal(res.status, 401, `presented ${JSON.stringify(presented)}`);
    }
    assert.equal(stub.calls.length, 0, 'a bad secret must never reach GitHub');
  } finally {
    stub.restore();
  }
});

test('owner id: a paste-mangled OWNER_ID still recognises the owner', async () => {
  for (const stored of ['"111111111"', ' 111111111 ', '111111111\n', "'111111111'"]) {
    const stub = stubFetch();
    try {
      const res = await worker.fetch(post(update()), { ...ENV, OWNER_ID: stored });
      assert.equal(res.status, 200, `stored as ${JSON.stringify(stored)}`);
      assert.ok(
        stub.put(),
        `the owner's own message must not be dropped as a stranger's, stored as ${JSON.stringify(stored)}`,
      );
    } finally {
      stub.restore();
    }
  }
});

test('owner id: trimming does not turn a stranger into the owner', async () => {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(
      post(update({ from: { id: 999 }, chat: { id: 999 } })),
      { ...ENV, OWNER_ID: '"111111111"' },
    );
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 0, 'a stranger must still be dropped silently');
  } finally {
    stub.restore();
  }
});

test('bot token: a paste-mangled BOT_TOKEN never reaches the Telegram URL', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post(update()), { ...ENV, BOT_TOKEN: '" bot-token "\n' });
    const tg = stub.calls.filter((c) => c.url.startsWith('https://api.telegram.org/'));
    assert.ok(tg.length > 0, 'expected a Telegram call');
    for (const call of tg) {
      assert.ok(
        call.url.startsWith('https://api.telegram.org/botbot-token/'),
        `token mangling leaked into the URL: ${call.url}`,
      );
    }
  } finally {
    stub.restore();
  }
});

test('github repo + token: paste mangling never reaches the GitHub API', async () => {
  const stub = stubFetch();
  try {
    await worker.fetch(post(update()), {
      ...ENV,
      GITHUB_REPO: '" example/vault "',
      GITHUB_TOKEN: '"gh-token"\n',
    });
    const gh = stub.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
    assert.ok(gh.length > 0, 'expected a GitHub call');
    for (const call of gh) {
      assert.ok(
        call.url.startsWith('https://api.github.com/repos/example/vault/contents/'),
        `repo mangling leaked into the URL: ${call.url}`,
      );
      assert.equal(
        call.headers.Authorization,
        'Bearer gh-token',
        'token mangling leaked into the Authorization header',
      );
    }
  } finally {
    stub.restore();
  }
});
