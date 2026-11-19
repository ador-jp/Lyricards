import * as Sentry from '@sentry/cloudflare';
import handler from 'vinext/server/fetch-handler';
import { ensureFetchPatch } from 'vinext/shims/fetch-cache';
import { sentryOptions, shouldTrace } from './lib/sentry.ts';
import type { SentryEnv } from './lib/sentry.ts';

const traced = Sentry.withSentry(
  (env: SentryEnv): Sentry.CloudflareOptions => ({
    ...sentryOptions(env),
    integrations: defaults => [
      ...defaults.filter(integration => integration.name !== 'Fetch'),
      {
        name: 'VinextFetch',
        setupOnce() {
          // Vinext installs its own fetch; instrument that wrapper, not the native fetch it captures.
          ensureFetchPatch();
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (input, init) => {
            if (!Sentry.getActiveSpan()?.isRecording()) return originalFetch(input, init);
            const url = input instanceof Request ? input.url : String(input);
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            return Sentry.startSpan({ name: `${method} ${new URL(url).origin}${new URL(url).pathname}`, op: 'http.client' }, async span => {
              const response = await originalFetch(input, init);
              Sentry.setHttpStatus(span, response.status);
              return response;
            });
          };
        },
      },
    ],
  }),
  {
    fetch(request: Request, env: SentryEnv, ctx: ExecutionContext) {
      const name = `${request.method} ${new URL(request.url).pathname}`;
      const span = Sentry.getActiveSpan();
      if (span) {
        span.updateName(name);
        span.setAttribute('sentry.source', 'route');
        return handler.fetch(request, env, ctx);
      }
      // The SDK skips root spans for HEAD and OPTIONS.
      return Sentry.startSpan({ name, op: 'http.server', attributes: { 'sentry.source': 'route' } }, async span => {
        const response = await handler.fetch(request, env, ctx);
        Sentry.setHttpStatus(span, response.status);
        return response;
      });
    },
  },
);

const worker = {
  fetch(request: Request, env: SentryEnv, ctx: ExecutionContext) {
    if (!shouldTrace(request, env)) return handler.fetch(request, env, ctx);
    return traced.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  },
};

export default worker;
