import { z } from 'zod';
import type { SetupJournal } from '../ports/setup.ts';
import type { AccountStore, StoredAccount } from './account-store.ts';
import { onboardingSteps, onboardingVersion, interviewAnswerChars } from '../shared/onboarding.ts';

export const setupAccountSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    onboardingCompleted: z.boolean(),
    displayName: z.string().max(200).nullable(),
    usageData: z.boolean(),
    traces: z.boolean(),
    consentRevision: z.number().int().nonnegative(),
    consentAnswered: z.boolean(),
  })
  .strict();
export const setupProgressSchema = z
  .object({
    version: z.literal(onboardingVersion),
    step: z.enum(onboardingSteps),
    visited: z.array(z.enum(onboardingSteps)).max(onboardingSteps.length),
    about: z
      .object({
        answers: z.array(z.string().max(interviewAnswerChars)).max(3),
        turns: z.array(z.array(z.string().max(1000)).max(3)).max(4),
        done: z.boolean(),
      })
      .strict()
      .optional(),
    completing: z.boolean(),
  })
  .strict();
export const initialSetupProgress = () => ({
  version: onboardingVersion,
  step: 'welcome' as const,
  visited: ['welcome' as const],
  completing: false,
});
export function createSetupAccount(journal: SetupJournal, ownerId: string): AccountStore {
  const initial = () => ({
    theme: 'system' as const,
    onboardingCompleted: false,
    displayName: null,
    usageData: false,
    traces: false,
    consentRevision: 0,
    consentAnswered: false,
  });
  function owner(value: string) {
    if (value !== ownerId) throw new Error('This setup belongs to another profile.');
  }
  async function read() {
    return setupAccountSchema.parse((await journal.read('account')) ?? initial());
  }
  return {
    async readConsent(id) {
      owner(id);
      const account = await read();
      return { enabled: account.usageData, revision: String(account.consentRevision) };
    },
    async read(id): Promise<StoredAccount> {
      owner(id);
      return read();
    },
    async update(id, input) {
      owner(id);
      if (input.onboardingCompleted !== undefined)
        throw Object.assign(new Error('Finish all setup steps first.'), { statusCode: 409 });
      return journal.update<z.infer<typeof setupAccountSchema>>('account', (current) => {
        const previous = setupAccountSchema.parse(current ?? initial());
        return setupAccountSchema.parse({
          ...previous,
          ...input,
          consentAnswered: previous.consentAnswered || input.usageData !== undefined,
          consentRevision:
            previous.consentRevision +
            (input.usageData !== undefined && input.usageData !== previous.usageData ? 1 : 0),
        });
      });
    },
  };
}
