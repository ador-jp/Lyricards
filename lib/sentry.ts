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
    delete event.request.headers;
    delete event.request.query_string;
    delete event.request.env;
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
  }
  if (event.user) delete event.user.ip_address;
  for (const span of event.spans ?? []) {
    if (span.op === 'http.client' && span.description) span.description = withoutQuery(span.description);
  }
  for (const data of [event.contexts?.trace?.data, ...(event.spans ?? []).map(span => span.data), ...(event.breadcrumbs ?? []).map(crumb => crumb.data)]) {
    for (const name of Object.keys(data ?? {})) {
      if (/^(http\.(request|response)\.header\.|http\.query$|url\.query$|client\.address$|network\.peer\.address$|http\.client_ip$|user\.ip_address$|user_agent\.original$)/i.test(name)) {
        delete data![name];
      } else if (typeof data![name] === 'string' && /(^url($|\.)|url$|uri$|http\.target$)/i.test(name)) {
        data![name] = withoutQuery(data![name] as string);
      }
    }
  }
  return event;
}

function withoutQuery(value: string): string {
  return value.split(/[?#]/, 1)[0];
}
