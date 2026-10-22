export function connectionUrl(value: string, origin: string) {
  const url = new URL(value, origin);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === origin))
  )
    throw new Error('The sign-in address could not be verified.');
  return url.href;
}
