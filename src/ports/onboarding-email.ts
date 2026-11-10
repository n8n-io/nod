import type { OnboardingProfile } from '../shared/onboarding.ts';

export type OnboardingEmailSubmission = {
  email: string;
  profile?: OnboardingProfile;
};

export interface OnboardingEmailDelivery {
  configured: boolean;
  submit(input: OnboardingEmailSubmission, signal: AbortSignal): Promise<boolean>;
}
