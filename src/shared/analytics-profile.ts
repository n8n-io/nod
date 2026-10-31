import { z } from 'zod';

export const analyticsProfileSchema = z
  .object({
    role: z.enum(['agency_owner', 'business_owner', 'employee', 'individual', 'other']).optional(),
    company_size: z.enum(['solo', '2_10', '11_50', '51_200', '201_plus']).optional(),
    ai_experience: z.enum(['new', 'occasional', 'regular', 'technical']).optional(),
    ai_tools: z
      .array(
        z.enum(['chatgpt', 'claude', 'gemini', 'copilot', 'n8n', 'coding_agents', 'other', 'none']),
      )
      .max(8)
      .refine((values) => new Set(values).size === values.length)
      .refine((values) => !values.includes('none') || values.length === 1)
      .optional(),
  })
  .strict();

export type AnalyticsProfile = z.infer<typeof analyticsProfileSchema>;

export function analyticsProfileProperties(profile: AnalyticsProfile) {
  return Object.fromEntries(
    Object.entries(analyticsProfileSchema.parse(profile))
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`profile_${key}`, value]),
  ) as Record<string, string | string[]>;
}
