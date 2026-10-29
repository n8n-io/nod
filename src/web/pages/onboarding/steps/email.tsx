import { onboardingEmailProviders } from '../../../../shared/onboarding';
import type { StepProps } from '..';
import { emailCopy } from './connection-preview';
import { PersonalConnection } from './personal-connection';

export function Email(props: StepProps) {
  return (
    <PersonalConnection
      {...props}
      kind="email"
      providerSlugs={onboardingEmailProviders}
      introduction={emailCopy.introduction}
      action={emailCopy.action}
      note={emailCopy.note}
    />
  );
}
