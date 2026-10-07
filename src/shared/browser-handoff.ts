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
      deltaX: z.number().int().min(-2000).max(2000),
      deltaY: z.number().int().min(-2000).max(2000),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }).strict(),
  z
    .object({
      type: z.literal('key'),
      key: z
        .string()
        .min(1)
        .max(40)
        .regex(/^[A-Za-z0-9+]+$/),
    })
    .strict(),
]);

export const browserHandoffInputs = z.array(browserHandoffInput).min(1).max(100);

export type BrowserHandoffInput = z.infer<typeof browserHandoffInput>;
