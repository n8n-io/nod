import type { onboardingPersonProperties } from '../shared/onboarding-analytics.ts';

export type OnboardingEmailProfile = ReturnType<typeof onboardingPersonProperties>;

export type OnboardingEmailSubmission = {
  email: string;
  profile?: OnboardingEmailProfile;
};

export interface OnboardingEmailDelivery {
  configured: boolean;
  submit(input: OnboardingEmailSubmission, signal: AbortSignal): Promise<boolean>;
}
