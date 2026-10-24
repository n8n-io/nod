import type { MessagingAttachment } from '../../ports/messaging.ts';
import { sharedLocation } from '../../shared/channel-content.ts';

export function locationAttachment(input: unknown): MessagingAttachment[] {
  const parsed = sharedLocation.safeParse(input);
  if (!parsed.success) return [];
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  return [
    {
      name: 'location.json',
      mimeType: 'application/json',
      size: bytes.length,
      source: 'location',
      read: async () => bytes,
    },
  ];
}

export function contactAttachment(cards: string[]): MessagingAttachment[] {
  const text = cards.filter((card) => card.trim()).join('\r\n');
  if (!text) return [];

  return [
    {
      name: 'contact.vcf',
      mimeType: 'text/vcard',
      size: Buffer.byteLength(text),
      source: 'contact',
      read: async () => Buffer.from(text),
    },
  ];
}

export function telegramContactCard(contact: {
  first_name: string;
  last_name?: string;
  phone_number: string;
  vcard?: string;
}) {
  if (contact.vcard) return contact.vcard;
  const escape = (value: string) =>
    value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');
  return `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${escape([contact.first_name, contact.last_name].filter(Boolean).join(' '))}\r\nTEL:${escape(contact.phone_number)}\r\nEND:VCARD`;
}
