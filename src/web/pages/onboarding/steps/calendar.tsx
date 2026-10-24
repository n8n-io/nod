import type { Connection } from '../../../../shared/contracts';
import {
  onboardingCalendarProviders,
  onboardingEmailProviders,
} from '../../../../shared/onboarding';
import type { StepProps } from '..';
import { PersonalConnection } from './personal-connection';

function introduction(accounts: Connection[]) {
  return accounts.some((account) => onboardingEmailProviders.some((slug) => account.slug === slug))
    ? 'Your email is connected. I can help with your schedule too.'
    : 'I can help you spend less time managing your schedule.';
}

export function Calendar(props: StepProps) {
  return (
    <PersonalConnection
      {...props}
      kind="calendar"
      providerSlugs={onboardingCalendarProviders}
      introduction={introduction}
      benefit="Connect your calendar so I can handle the scheduling and pull together what you need for your next meeting."
    />
  );
}
