import { authenticatorKey } from './authenticator-key.ts';
import { loopbackHost } from './loopback.ts';

export type ImportedLogin = {
  label: string;
  origin: string;
  username: string;
  password: string;
  authenticatorKey?: string;
};

const columns = {
  url: ['url', 'login_uri', 'website', 'login uri', 'web site'],
  username: ['username', 'login_username', 'user name', 'login'],
  email: ['email', 'e-mail'],
  password: ['password', 'login_password'],
  label: ['title', 'name'],
  archived: ['archived'],
  authenticator: ['otpauth', 'login_totp', 'totp'],
};

function records(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let start = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"' && start) {
      quoted = true;
      start = false;
    } else if (char === ',') {
      row.push(field);
      field = '';
      start = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      rows.push([...row, field]);
      row = [];
      field = '';
      start = true;
    } else {
      field += char;
      start = false;
    }
  }
  if (quoted) throw new Error('The CSV file has an incomplete quoted field. Export it again.');
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((values) => values.some((value) => value.trim()));
}

function origin(address: string) {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `https://${address}`);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    const secure = url.protocol === 'https:' || loopbackHost(url.hostname);
    if (!secure) url.protocol = 'https:';
    return { origin: url.origin, secure };
  } catch {
    return undefined;
  }
}

export function parsePasswordCsv(text: string) {
  const [header = [], ...rows] = records(text.replace(/^\uFEFF/, ''));
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (keys: string[]) =>
    keys.map((key) => names.indexOf(key)).find((index) => index >= 0) ?? -1;
  const url = column(columns.url);
  const password = column(columns.password);
  const username = column(columns.username);
  const email = column(columns.email);
  const label = column(columns.label);
  const archived = column(columns.archived);
  const authenticator = column(columns.authenticator);
  if (url < 0 || password < 0)
    throw new Error('Choose a CSV file exported from a password manager.');
  let unreadable = 0;
  let unusableKeys = 0;
  const found = rows.flatMap((row) => {
    const value = (index: number) => (index < 0 ? '' : (row[index] ?? ''));
    if (row.length !== names.length) {
      unreadable++;
      return [];
    }
    if (!value(password) || value(archived).trim().toLowerCase() === 'true') return [];
    const site = value(url)
      .split(/[\s,]+/)
      .map(origin)
      .find((candidate) => candidate);
    if (!site) {
      unreadable++;
      return [];
    }
    const key = value(authenticator).trim() ? authenticatorKey(value(authenticator)) : undefined;
    if (value(authenticator).trim() && !key) unusableKeys++;
    return [
      {
        secure: site.secure,
        login: {
          label: value(label).trim(),
          origin: site.origin,
          username: value(username).trim() || value(email).trim(),
          password: value(password),
          ...(key ? { authenticatorKey: key } : {}),
        },
      },
    ];
  });
  return {
    logins: [...found.filter((item) => item.secure), ...found.filter((item) => !item.secure)].map(
      (item) => item.login,
    ),
    unreadable,
    unusableKeys,
  };
}
