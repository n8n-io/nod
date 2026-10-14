export function loopbackHost(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
