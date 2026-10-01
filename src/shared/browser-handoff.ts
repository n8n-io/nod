import { z } from 'zod';

export const browserHandoffKeys = [
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;

export const browserHandoffInput = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('click'), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .strict(),
  z.object({ type: z.literal('scroll'), deltaY: z.number().int().min(-2000).max(2000) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(browserHandoffKeys) }).strict(),
]);

export type BrowserHandoffInput = z.infer<typeof browserHandoffInput>;
