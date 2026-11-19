import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { sentryOptions, shouldTrace } from './sentry.ts';

void test('only API requests with a runtime DSN enable Sentry', () => {
  for (const route of ['dictionary', 'entries', 'genius', 'songs']) {
    const request = new Request(`https://example.test/api/${route}?q=test`);
    assert.equal(shouldTrace(request, {}), false);
    assert.equal(shouldTrace(request, { SENTRY_DSN: '  ' }), false);
    assert.equal(shouldTrace(request, { SENTRY_DSN: 'runtime-dsn' }), true);
  }
  for (const path of ['/', '/api', '/apiary/test', '/assets/script.js']) {
    assert.equal(shouldTrace(new Request(`https://example.test${path}`), { SENTRY_DSN: 'runtime-dsn' }), false);
  }
});

const workerSource = readFileSync(new URL('../worker.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export default worker;', 'worker;');

void test('worker preserves bypass responses and instruments vinext fetch successes and failures', async () => {
  let active: unknown;
  let setup = false;
  let calls = 0;
  const spans: Array<{ name: string; op: string }> = [];
  const statuses: number[] = [];
  const failure = new Error('upstream unavailable');
  const response = new Response('{}');
  const scope = {
    Request, Response, URL, sentryOptions, shouldTrace,
    fetch: async (input: Request | string | URL) => {
      if ((input instanceof Request ? input.url : String(input)).includes('failure')) throw failure;
      return response;
    },
    ensureFetchPatch: () => { setup = true; },
    handler: { fetch: () => { calls++; return response; } },
    Sentry: {
      getActiveSpan: () => active,
      setHttpStatus: (_span: unknown, status: number) => statuses.push(status),
      startSpan: async (options: { name: string; op: string }, callback: (span: object) => unknown) => {
        spans.push(options);
        return await callback({});
      },
      withSentry: (options: (env: object) => { integrations: (defaults: object[]) => Array<{ setupOnce?: () => void }> }, handler: { fetch: (...args: unknown[]) => unknown }) => ({
        fetch: (...args: unknown[]) => {
          for (const integration of options({}).integrations([{ name: 'Fetch' }])) integration.setupOnce?.();
          return handler.fetch(...args);
        },
      }),
    },
  };
  const worker = runInNewContext(stripTypeScriptTypes(workerSource), scope);
  assert.equal(worker.fetch(new Request('https://example.test/api/songs'), {}, {}), response);
  assert.equal(worker.fetch(new Request('https://example.test/'), { SENTRY_DSN: 'dsn' }, {}), response);
  assert.equal(setup, false);
  assert.equal(calls, 2);
  await worker.fetch(new Request('https://example.test/api/entries', { method: 'HEAD' }), { SENTRY_DSN: 'dsn' }, {});
  assert.equal(setup, true);
  assert.equal(spans[0].name, 'HEAD /api/entries');
  assert.equal(spans[0].op, 'http.server');
  active = {};
  for (const host of ['api.tatoeba.org', 'api.datamuse.com', 'genius.com', 'itunes.apple.com', 'api.deezer.com']) {
    assert.equal(await scope.fetch(`https://${host}/search?q=private`), response);
    assert.equal(spans.at(-1)?.name, `GET https://${host}/search`);
    assert.equal(spans.at(-1)?.op, 'http.client');
  }
  await assert.rejects(scope.fetch('https://example.test/failure'), error => error === failure);
  assert.equal(statuses.length, 6);
  active = undefined;
  const count = spans.length;
  assert.equal(await scope.fetch('https://example.test/untraced'), response);
  assert.equal(spans.length, count);
});

void test('sampling and environment have safe defaults and accept runtime overrides', () => {
  assert.deepEqual(sentryOptions({}), {
    dsn: undefined, environment: 'production', tracesSampleRate: 1, tracePropagationTargets: [],
  });
  assert.equal(sentryOptions({ SENTRY_DSN: 'runtime-dsn' }).dsn, 'runtime-dsn');
  assert.equal(sentryOptions({ SENTRY_ENVIRONMENT: ' staging ' }).environment, 'staging');
  assert.equal(sentryOptions({ SENTRY_ENVIRONMENT: ' ' }).environment, 'production');
  for (const value of ['0', '0.25', '1']) {
    assert.equal(sentryOptions({ SENTRY_TRACES_SAMPLE_RATE: value }).tracesSampleRate, Number(value));
  }
  for (const value of ['', ' ', 'bad', '-1', '1.1', 'Infinity']) {
    assert.equal(sentryOptions({ SENTRY_TRACES_SAMPLE_RATE: value }).tracesSampleRate, 1);
  }
});
