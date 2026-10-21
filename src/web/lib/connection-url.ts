const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

function sameInstance(url: URL, instance?: string) {
  const typed = instance ? URL.parse(instance) : null;
  if (!typed || url.port !== typed.port || url.protocol !== typed.protocol) return false;
  return (
    url.hostname === typed.hostname || (loopback.has(url.hostname) && loopback.has(typed.hostname))
  );
}

export function connectionUrl(value: string, origin: string, instance?: string) {
  const url = new URL(value, origin);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && (url.origin === origin || sameInstance(url, instance))))
  )
    throw new Error('The sign-in address could not be verified.');
  return url.href;
}
