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
  };
}
