import { onboardingEmailProviders } from '../../../../shared/onboarding';
import type { StepProps } from '..';
import { PersonalConnection } from './personal-connection';

export function Email(props: StepProps) {
  return (
    <PersonalConnection
      {...props}
      kind="email"
      providerSlugs={onboardingEmailProviders}
      introduction="I can help you spend less time in your inbox."
      benefit="Connect your email so I can catch you up on what matters and draft replies for you to review."
    />
  );
}
