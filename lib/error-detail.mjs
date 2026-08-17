export function formatErrorDetail(error) {
  if (!error) return 'unknown error';
  const parts = [error.message || String(error)];
  for (const key of ['code', 'signal', 'stderr']) {
    if (error[key]) parts.push(`${key}=${String(error[key]).slice(0, 500)}`);
  }
  if (error.cause) {
    const cause = error.cause;
    const causeMessage = cause.message || String(cause);
    if (causeMessage && causeMessage !== parts[0]) parts.push(`cause=${String(causeMessage).slice(0, 500)}`);
    if (cause.code && cause.code !== error.code) parts.push(`causeCode=${String(cause.code).slice(0, 100)}`);
  }
  return parts.join(' ');
}
