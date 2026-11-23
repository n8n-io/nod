const percentEscape = /%([0-9a-f]{2})/gi;

function leavesPath(pathname: string) {
  for (let text = pathname, previous = ''; text !== previous;) {
    if (text.includes('\\') || text.split(/[/?#;]/).some((part) => part === '.' || part === '..'))
      return true;
    previous = text;
    text = text.replace(percentEscape, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return false;
}

export function appRequestUrl(endpoint: string, relative: string) {
  if (
    !relative ||
    relative.length > 2048 ||
    relative.startsWith('//') ||
    relative.includes('\\') ||
    relative.includes('#')
  )
    throw new Error('Use a path in the saved API address.');
  const base = new URL(endpoint);
  const url = new URL(
    relative.startsWith('/') ? `.${relative}` : relative,
    base.href.endsWith('/') ? base : `${base.href}/`,
  );
  try {
    decodeURIComponent(url.pathname);
  } catch {
    throw new Error('The API path has an invalid % escape.');
  }
  if (leavesPath(relative.split('?')[0]) || leavesPath(url.pathname))
    throw new Error(
      'The request must stay in the saved API address, so its path cannot contain a . or .. segment or a backslash, even percent-encoded.',
    );
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`)
  )
    throw new Error('The request must stay in the saved API address.');
  return url.href;
}

export function appRequestHeaders(path: { auth: string; apiKeyHeader?: string }, token: string) {
  return path.auth === 'x-api-key'
    ? { [path.apiKeyHeader ?? 'X-API-Key']: token }
    : { Authorization: `Bearer ${token}` };
}
