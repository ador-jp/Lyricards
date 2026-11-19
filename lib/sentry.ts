import type { Event } from '@sentry/cloudflare';

export type SentryEnv = {
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  SENTRY_ENVIRONMENT?: string;
};

export function shouldTrace(request: Request, env: SentryEnv) {
  return Boolean(env.SENTRY_DSN?.trim()) && new URL(request.url).pathname.startsWith('/api/');
}

export function sentryOptions(env: SentryEnv) {
  const value = env.SENTRY_TRACES_SAMPLE_RATE?.trim();
  const rate = value ? Number(value) : 1;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 1,
    tracePropagationTargets: [],
    sendDefaultPii: false,
    beforeSend: stripRequestCredentials,
    beforeSendTransaction: stripRequestCredentials,
  };
}

export function stripRequestCredentials<T extends Event>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    for (const name of Object.keys(event.request.headers ?? {})) {
      if (['cookie', 'authorization', 'x-lyricards-entry-owner'].includes(name.toLowerCase())) {
        delete event.request.headers![name];
      }
    }
  }
  for (const data of [event.contexts?.trace?.data, ...(event.spans ?? []).map(span => span.data)]) {
    for (const name of Object.keys(data ?? {})) {
      if (/^http\.request\.header\.(cookie|set_cookie|authorization|x_lyricards_entry_owner)(\.|$)/i.test(name)) {
        delete data![name];
      }
    }
  }
  return event;
}
