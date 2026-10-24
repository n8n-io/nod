import { z } from 'zod';

const account = z.string().trim().min(1).max(200);
const origin = z.string().min(1).max(2048);

export const helperRequest = z.discriminatedUnion('method', [
  z.object({ id: z.number().int(), method: z.literal('logins'), account, origin }).strict(),
  z
    .object({
      id: z.number().int(),
      method: z.literal('login'),
      account,
      origin,
      item: z.string().min(1).max(300),
    })
    .strict(),
]);

export const helperReply = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      id: z.number().int(),
      ok: z.literal(false),
      reason: z.enum(['unavailable', 'missing', 'failed']),
      message: z.string().max(500),
    })
    .strict(),
]);

export const loginsValue = z.array(
  z
    .object({
      id: z.string().min(1).max(300),
      title: z.string(),
      username: z.string(),
      website: z.string(),
    })
    .strict(),
);

export const loginValue = z
  .object({
    title: z.string(),
    username: z.string(),
    password: z.string().min(1),
    authenticatorKey: z.string().optional(),
  })
  .strict();

export type HelperRequest = z.infer<typeof helperRequest>;
