import { z } from 'zod';

export const sharedLocation = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
});

export type SharedLocation = z.infer<typeof sharedLocation>;

export function contactCards(text: string) {
  if (text.includes('\0')) return [];
  const separator = (line: string, state = { quoted: false }) => {
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '"') state.quoted = !state.quoted;
      else if (line[index] === ':' && !state.quoted) return index;
    }
    return -1;
  };
  const fieldHeader = /^(?:[\w-]+\.)?([A-Z][A-Z0-9-]*)(;.*)?$/i;
  const parameter = (header: string | undefined, name: string) =>
    header
      ?.match(/(?:[^;"]+|"[^"]*")+/g)
      ?.find((part) => part.slice(0, name.length + 1).toUpperCase() === `${name}=`)
      ?.slice(name.length + 1)
      .replace(/^"|"$/g, '');
  const cards: string[] = [];
  let current: string[] | undefined;
  const logical: string[][] = [];
  let quotedPrintable = false;
  let headerComplete = false;
  const headerState = { quoted: false };
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const previous = logical.at(-1);
    const end = previous?.at(-1);
    if (previous && quotedPrintable && end?.endsWith('=') && !/^(?:BEGIN|END):VCARD$/i.test(line)) {
      previous[previous.length - 1] = end.slice(0, -1);
      previous.push(line.replace(/^[ \t]/, ''));
    } else if (previous && /^[ \t]/.test(line)) previous.push(line.slice(1));
    else {
      logical.push([line]);
      quotedPrintable = headerComplete = false;
      headerState.quoted = false;
    }
    if (!headerComplete && separator(line, headerState) >= 0) {
      headerComplete = true;
      const unfolded = logical.at(-1)!.join('');
      const header = fieldHeader.exec(unfolded.slice(0, separator(unfolded)))?.[2];
      quotedPrintable = parameter(header, 'ENCODING')?.toUpperCase() === 'QUOTED-PRINTABLE';
    }
  }
  for (const parts of logical) {
    const line = parts.join('');
    if (/^BEGIN:VCARD$/i.test(line)) {
      if (current) return [];
      current = [line];
    } else if (/^END:VCARD$/i.test(line)) {
      if (!current) return [];
      cards.push([...current, line].join('\r\n'));
      current = undefined;
    } else if (current) current.push(line);
  }
  if (current) return [];
  const unescape = (value: string) =>
    value
      .replace(/\\([nN,;\\])/g, (_, escaped: string) => (/n/i.test(escaped) ? '\n' : escaped))
      .trim();
  const parsed = cards.flatMap((vcard) => {
    const fields = vcard.split(/\r?\n/).flatMap((line) => {
      const end = separator(line);
      if (end < 0) return [];
      const match = fieldHeader.exec(line.slice(0, end));
      if (!match) return [];
      let value = line.slice(end + 1);
      if (parameter(match[2], 'ENCODING')?.toUpperCase() === 'QUOTED-PRINTABLE') {
        const bytes: number[] = [];
        for (const part of value.match(/=[\da-f]{2}|[^=]+|=/gi) ?? []) {
          if (/^=[\da-f]{2}$/i.test(part)) bytes.push(Number.parseInt(part.slice(1), 16));
          else for (const byte of new TextEncoder().encode(part)) bytes.push(byte);
        }
        try {
          value = new TextDecoder(parameter(match[2], 'CHARSET') ?? 'utf-8', {
            fatal: true,
          }).decode(new Uint8Array(bytes));
        } catch {}
      }
      return [{ key: match[1].toUpperCase(), value }];
    });
    const first = (key: string) => fields.find((field) => field.key === key)?.value ?? '';
    const components = (value: string) => {
      const parts = [''];
      for (let index = 0; index < value.length; index++) {
        if (value[index] === '\\' && index + 1 < value.length)
          parts[parts.length - 1] += value[index] + value[++index];
        else if (value[index] === ';') parts.push('');
        else parts[parts.length - 1] += value[index];
      }
      return parts;
    };
    const [family, given, additional, prefix, suffix] = components(first('N'));
    const name = unescape(
      first('FN') || [prefix, given, additional, family, suffix].filter(Boolean).join(' '),
    ).slice(0, 200);
    if (!name) return [];
    return [
      {
        name,
        phones: fields
          .filter((field) => field.key === 'TEL')
          .slice(0, 10)
          .map((field) => unescape(field.value).replace(/^tel:/i, '').slice(0, 100)),
        emails: fields
          .filter((field) => field.key === 'EMAIL')
          .slice(0, 10)
          .map((field) =>
            unescape(field.value)
              .replace(/^mailto:/i, '')
              .slice(0, 254),
          ),
        organization: components(first('ORG'))
          .map(unescape)
          .filter(Boolean)
          .join(' · ')
          .slice(0, 200),
        title: unescape(first('TITLE')).slice(0, 200),
        addresses: fields
          .filter((field) => field.key === 'ADR')
          .slice(0, 10)
          .map((field) =>
            components(field.value).map(unescape).filter(Boolean).join(', ').slice(0, 500),
          ),
        urls: fields
          .filter((field) => field.key === 'URL')
          .slice(0, 10)
          .map((field) => unescape(field.value).slice(0, 2048)),
        vcard,
      },
    ];
  });
  return parsed.length === cards.length ? parsed : [];
}
