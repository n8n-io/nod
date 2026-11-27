import { z } from 'zod';

export function normalizedEmail(value: unknown) {
  const result = z.string().trim().toLowerCase().pipe(z.email().max(320)).safeParse(value);
  return result.success ? result.data : undefined;
}
