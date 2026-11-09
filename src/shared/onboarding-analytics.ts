import { profileBusinessRoles, type OnboardingProfile } from './onboarding.ts';

export function onboardingProfileAnswers(profile: OnboardingProfile) {
  const hasRole = (role: OnboardingProfile['roles'][number]) => profile.roles.includes(role);
  const hasJob = (job: OnboardingProfile['jobs'][number]) => profile.jobs.includes(job);
  const asksWhoFor = profile.roles.some((role) => profileBusinessRoles.includes(role));

  return {
    scope: profile.scope ?? 'skipped',
    role_owner: hasRole('owner'),
    role_freelance: hasRole('freelance'),
    role_agency: hasRole('agency'),
    role_engineering: hasRole('engineering'),
    role_product: hasRole('product'),
    role_gtm: hasRole('gtm'),
    role_manager: hasRole('manager'),
    role_student: hasRole('student'),
    role_not_working: hasRole('not_working'),
    role_other: Boolean(profile.roleText),
    who_for: asksWhoFor ? (profile.whoFor ?? 'skipped') : 'not_asked',
    company_size: profile.scope === 'personal' ? 'not_asked' : (profile.companySize ?? 'skipped'),
    job_email: hasJob('email'),
    job_calendar: hasJob('calendar'),
    job_meetings: hasJob('meetings'),
    job_errands: hasJob('errands'),
    job_research: hasJob('research'),
    job_routines: hasJob('routines'),
    job_other: Boolean(profile.jobsText),
  } as const;
}

export type OnboardingProfileAnswers = ReturnType<typeof onboardingProfileAnswers>;

export function onboardingPersonProperties(profile: OnboardingProfile) {
  return {
    onboarding_profile_completed: true,
    ...Object.fromEntries(
      Object.entries(onboardingProfileAnswers(profile)).map(([key, value]) => [
        `onboarding_${key}`,
        value,
      ]),
    ),
  };
}
