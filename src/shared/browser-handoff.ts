import { z } from 'zod';

const fraction = z.number().min(0).max(1);

export const browserHandoffInput = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('mouse'),
      event: z.enum(['move', 'down', 'up']),
      x: fraction,
      y: fraction,
      button: z.enum(['left', 'middle', 'right']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('wheel'),
      deltaX: z.number().int(),
      deltaY: z.number().int(),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal('copy') }).strict(),
  z
    .object({
      type: z.literal('key'),
      key: z.string().regex(/^[A-Za-z0-9+]+$/),
    })
    .strict(),
]);

export const browserHandoffInputs = z.array(browserHandoffInput).min(1);

export type BrowserHandoffInput = z.infer<typeof browserHandoffInput>;
