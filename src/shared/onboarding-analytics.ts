import {
  profileBusinessRoles,
  profileJobs,
  profileRoles,
  type OnboardingProfile,
} from './onboarding.ts';

export const legacyOnboardingChoiceProperties = [
  ...profileRoles.map(({ id }) => `onboarding_role_${id}`),
  'onboarding_role_other',
  ...profileJobs.map(({ id }) => `onboarding_job_${id}`),
  'onboarding_job_follow_ups',
  'onboarding_job_other',
];

function selectedChoices<T extends string>(
  options: readonly { id: T }[],
  selected: readonly T[],
  other: boolean,
) {
  const values: string[] = options.filter(({ id }) => selected.includes(id)).map(({ id }) => id);
  if (other) values.push('other');
  return values.length ? values : ['skipped'];
}

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
  const answers = onboardingProfileAnswers(profile);
  return {
    onboarding_profile_completed: true,
    onboarding_scope: answers.scope,
    onboarding_roles: selectedChoices(profileRoles, profile.roles, answers.role_other),
    onboarding_who_for: answers.who_for,
    onboarding_company_size: answers.company_size,
    onboarding_jobs: selectedChoices(profileJobs, profile.jobs, answers.job_other),
  };
}
