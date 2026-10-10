export type ImportedLogin = { label: string; url: string; username: string; password: string };

const columns = {
  url: ['url', 'website', 'login_uri', 'login uri', 'web site'],
  username: ['username', 'login_username', 'login', 'email', 'user name'],
  password: ['password', 'login_password'],
  label: ['title', 'name'],
  archived: ['archived'],
};

function records(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      rows.push([...row, field]);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((values) => values.some((value) => value.trim()));
}

export function parsePasswordCsv(text: string): ImportedLogin[] {
  const [header = [], ...rows] = records(text.replace(/^﻿/, ''));
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (keys: string[]) => names.findIndex((name) => keys.includes(name));
  const url = column(columns.url);
  const password = column(columns.password);
  const username = column(columns.username);
  const label = column(columns.label);
  const archived = column(columns.archived);
  if (url < 0 || password < 0)
    throw new Error('Choose a CSV file exported from a password manager.');
  return rows.flatMap((row) => {
    const value = (index: number) => (index < 0 ? '' : (row[index] ?? ''));
    const address =
      value(url)
        .trim()
        .split(/[\s,]+/)[0] ?? '';
    if (!address || !value(password) || value(archived).trim().toLowerCase() === 'true') return [];
    return [
      {
        label: value(label).trim(),
        url: address,
        username: value(username).trim(),
        password: value(password),
      },
    ];
  });
}
