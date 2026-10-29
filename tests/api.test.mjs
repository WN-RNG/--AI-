import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/api.ts';

async function withFetch(fetcher, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test('aborting while the response body is read remains AbortError instead of empty successful data', async () => {
  const controller = new AbortController();
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    }),
    async () => {
      await assert.rejects(
        api('/albums', { signal: controller.signal }),
        (error) => error.name === 'AbortError',
      );
    },
  );
});

test('an aborted response is preserved even when the caller did not provide a signal', async () => {
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException('Cancelled', 'AbortError');
      },
    }),
    async () => {
      await assert.rejects(api('/albums'), (error) => error.name === 'AbortError');
    },
  );
});

test('invalid JSON and invalid success shapes cannot reach the album state as empty data', async () => {
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Incomplete JSON');
      },
    }),
    async () => {
      await assert.rejects(api('/albums'), /响应格式异常/);
    },
  );
  for (const body of [null, [], 'unexpected']) {
    await withFetch(
      async () => ({ ok: true, status: 200, json: async () => body }),
      async () => {
        await assert.rejects(api('/albums'), /响应数据异常/);
      },
    );
  }
});

test('valid data and server errors retain the existing same-origin request contract', async () => {
  await withFetch(
    async (url, options) => {
      assert.equal(url, '/api/albums');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers.get('X-Album-Client'), '1');
      return { ok: true, status: 201, json: async () => ({ album: { id: 'created' } }) };
    },
    async () => {
      assert.deepEqual(
        await api('/albums', { method: 'POST', body: JSON.stringify({ title: 'Example' }) }),
        { album: { id: 'created' } },
      );
    },
  );
  await withFetch(
    async () => ({ ok: false, status: 403, json: async () => ({ error: '邀请码不正确' }) }),
    async () => {
      await assert.rejects(api('/auth/register'), /邀请码不正确/);
    },
  );
});
