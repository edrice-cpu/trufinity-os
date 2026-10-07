export function redact(message: string): string {
  return message
    .replace(/(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/g, '[REDACTED_JWT]')
    .replace(/(Bearer\s+\S+)/gi, '[REDACTED_AUTH]')
    .replace(/(-----BEGIN[\s\S]*?-----END[^-]*-----)/g, '[REDACTED_KEY]')
    .replace(/([a-zA-Z0-9-_]{40,})/g, '[REDACTED_TOKEN]')
    .replace(/(https?:\/\/[^\s]+)/g, '[REDACTED_URL]');
}

export function causeStatus(cause: unknown): string {
  const c = cause as { response?: { status?: unknown }; code?: unknown } | null;
  if (c && typeof c.response?.status === 'number') return String(c.response.status);
  if (c && typeof c.code === 'number') return String(c.code);
  return 'unknown';
}
