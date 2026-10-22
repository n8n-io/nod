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
  const cards: string[] = [];
  let current: string[] | undefined;
  for (const line of text
    .replace(/^\uFEFF/, '')
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)) {
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
      .replace(/\\n/gi, '\n')
      .replace(/\\([,;\\])/g, '$1')
      .trim();
  const parsed = cards.flatMap((vcard) => {
    const fields = vcard.split(/\r?\n/).flatMap((line) => {
      const match = /^(?:[\w-]+\.)?([A-Z]+)(?:;[^:]*)?:(.*)$/i.exec(line);
      return match ? [{ key: match[1].toUpperCase(), value: match[2] }] : [];
    });
    const first = (key: string) => fields.find((field) => field.key === key)?.value ?? '';
    const name = unescape(
      first('FN') || first('N').split(';').filter(Boolean).reverse().join(' '),
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
          .map((field) => unescape(field.value).slice(0, 254)),
        organization: unescape(first('ORG')).slice(0, 200),
        vcard,
      },
    ];
  });
  return parsed.length === cards.length ? parsed : [];
}
