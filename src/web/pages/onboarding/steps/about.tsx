import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  profileBusinessRoles,
  profileCompanySizes,
  profileJobs,
  profileRoles,
  profileScopes,
  profileTextChars,
  profileWhoFor,
  type OnboardingProfile,
  type ProfileJob,
  type ProfileRole,
} from '../../../../shared/onboarding';
import { onboardingProfileAnswers } from '../../../../shared/onboarding-analytics';
import { Check, Pencil, X } from '../../../components/icons';
import { prefersReducedMotion, Rise } from '../../../components/motion';
import { Notice } from '../../../components/ui';
import { api, ApiError, errorMessage } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal } from '../motion';
import { readStored, writeStored } from '../storage';

type Question = 'scope' | 'roles' | 'whoFor' | 'size' | 'jobs';
type State = {
  current: Question | 'done';
  seen: Question[];
  profile: OnboardingProfile;
  editing: 'roles' | 'jobs' | null;
};

const prompts: Record<Question, string> = {
  scope: 'Where would you like my help?',
  roles: 'What do you do?',
  whoFor: 'Who is it for?',
  size: 'How big is your company?',
  jobs: 'What would you like to take off your plate?',
};

const fresh: State = {
  current: 'scope',
  seen: [],
  profile: { roles: [], jobs: [] },
  editing: null,
};

function questions(profile: OnboardingProfile): Question[] {
  const items: Question[] = ['scope', 'roles'];
  if (profile.roles.some((role) => profileBusinessRoles.includes(role))) items.push('whoFor');
  if (profile.scope !== 'personal') items.push('size');
  items.push('jobs');
  return items;
}

function applicable(profile: OnboardingProfile): OnboardingProfile {
  const roles =
    profile.scope === 'personal'
      ? profile.roles
      : profile.roles.filter((role) => role !== 'student' && role !== 'not_working');
  return {
    ...profile,
    roles,
    whoFor: roles.some((role) => profileBusinessRoles.includes(role)) ? profile.whoFor : undefined,
    companySize: profile.scope === 'personal' ? undefined : profile.companySize,
  };
}

function trimmed(profile: OnboardingProfile): OnboardingProfile {
  return applicable({
    ...profile,
    roleText: profile.roleText?.trim() || undefined,
    jobsText: profile.jobsText?.trim() || undefined,
  });
}

function label(list: readonly { id: string; label: string }[], id?: string) {
  return list.find((item) => item.id === id)?.label;
}

function answer(question: Question, profile: OnboardingProfile) {
  if (question === 'scope') return label(profileScopes, profile.scope);
  if (question === 'roles')
    return (
      [...profile.roles.map((role) => label(profileRoles, role)), profile.roleText]
        .filter(Boolean)
        .join(', ') || undefined
    );
  if (question === 'whoFor') return label(profileWhoFor, profile.whoFor);
  if (question === 'size') return label(profileCompanySizes, profile.companySize);
  return (
    [...profile.jobs.map((job) => label(profileJobs, job)), profile.jobsText]
      .filter(Boolean)
      .join(', ') || undefined
  );
}

function restore(): State | undefined {
  const stored = readStored<State>('about');
  if (
    !stored?.profile ||
    !Array.isArray(stored.seen) ||
    !Array.isArray(stored.profile.roles) ||
    !Array.isArray(stored.profile.jobs)
  )
    return;
  const profile = trimmed(stored.profile);
  const list = questions(profile);
  const seen = stored.seen.filter((question) => list.includes(question));
  return {
    current:
      stored.current === 'done' && list.every((question) => seen.includes(question))
        ? 'done'
        : list.includes(stored.current as Question)
          ? stored.current
          : (list.find((question) => !seen.includes(question)) ?? 'scope'),
    seen,
    profile,
    editing: null,
  };
}

function Chip({
  on,
  check = false,
  onClick,
  children,
}: {
  on: boolean;
  check?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="ob-chip" aria-pressed={on} onClick={onClick}>
      {check && (
        <span className="ob-chip-mark" aria-hidden="true">
          {on && <Check size={12} strokeWidth={3} />}
        </span>
      )}
      {children}
    </button>
  );
}

function Other({
  open,
  value,
  onOpen,
  onChange,
  onEnter,
  onAction,
}: {
  open: boolean;
  value: string;
  onOpen(): void;
  onChange(value: string): void;
  onEnter(): void;
  onAction(): void;
}) {
  if (!open)
    return (
      <button type="button" className="ob-chip" onClick={onOpen}>
        <Pencil size={16} aria-hidden="true" />
        Something else
      </button>
    );
  return (
    <span className="ob-chip-input">
      <Pencil size={16} aria-hidden="true" />
      <input
        type="text"
        aria-label="Something else"
        placeholder="Something else"
        value={value}
        maxLength={profileTextChars}
        autoFocus
        data-analytics-private
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onEnter();
          }
        }}
      />
      <button
        type="button"
        className="ob-chip-action"
        aria-label="Clear something else"
        onClick={onAction}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </span>
  );
}

function Reply({ text, onEdit, disabled }: { text: string; onEdit(): void; disabled?: boolean }) {
  return (
    <div className="ob-reply">
      <button
        type="button"
        className="ob-reply-edit"
        aria-label="Edit answer"
        onClick={onEdit}
        disabled={disabled}
      >
        <Pencil size={16} aria-hidden="true" />
      </button>
      <div className="ob-bubble ob-user-bubble" data-analytics-private>
        {text}
      </div>
    </div>
  );
}

export function About({ arrived, quiet, onNext, onBack, usageShared }: StepProps) {
  const [restored] = useState(restore);
  const [state, setState] = useState<State>(() => restored ?? fresh);
  const [typing, setTyping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [canContinue, setCanContinue] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const intro = useReveal([{ typing: 450 }, { wait: 200 }, { wait: 200 }], {
    enabled: arrived === 'forward' && !quiet && !restored,
  });
  const { profile, current, editing } = state;
  const list = questions(profile);
  const has = (job: ProfileJob) => profile.jobs.includes(job);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => writeStored('about', state), [state]);
  useLayoutEffect(() => {
    if (!moved.current) return void (moved.current = true);
    end.current?.scrollIntoView({
      block: 'end',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [current, typing, error]);

  function settle(question: Question, next: OnboardingProfile) {
    const profile = trimmed(next);
    const list = questions(profile);
    let seen = (state.seen.includes(question) ? state.seen : [...state.seen, question]).filter(
      (item) => list.includes(item),
    );
    if (
      question === 'scope' &&
      state.profile.roles.some((role) => !profile.roles.includes(role)) &&
      !profile.roles.length &&
      !profile.roleText
    )
      seen = seen.filter((item) => item !== 'roles');
    const upcoming = list.find((item) => !seen.includes(item)) ?? 'done';
    setError('');
    setCanContinue(false);
    setState({ current: upcoming, seen, profile, editing: null });
    if (upcoming === 'done') return void finish(profile);
    if (prefersReducedMotion()) return;
    window.clearTimeout(timer.current);
    setTyping(true);
    timer.current = window.setTimeout(() => setTyping(false), 900);
  }

  function edit(question: Question) {
    window.clearTimeout(timer.current);
    setTyping(false);
    setError('');
    setCanContinue(false);
    setState((value) => ({ ...value, current: question, editing: null }));
  }

  function skip(question: Question) {
    if (question === 'scope') return settle(question, { ...profile, scope: undefined });
    if (question === 'roles')
      return settle(question, { ...profile, roles: [], roleText: undefined, whoFor: undefined });
    if (question === 'whoFor') return settle(question, { ...profile, whoFor: undefined });
    if (question === 'size') return settle(question, { ...profile, companySize: undefined });
    return settle(question, { ...profile, jobs: [], jobsText: undefined });
  }

  function sendRoles() {
    if (profile.roles.length || profile.roleText?.trim()) settle('roles', profile);
  }

  function sendJobs() {
    if (profile.jobs.length || profile.jobsText?.trim()) settle('jobs', profile);
  }

  function toggleRole(role: ProfileRole) {
    setError('');
    setState((value) => {
      const profile = applicable({
        ...value.profile,
        roles: value.profile.roles.includes(role)
          ? value.profile.roles.filter((item) => item !== role)
          : [...value.profile.roles, role],
      });
      return {
        ...value,
        seen: profile.roles.some((item) => profileBusinessRoles.includes(item))
          ? value.seen
          : value.seen.filter((item) => item !== 'whoFor'),
        profile,
      };
    });
  }

  function toggleJob(job: ProfileJob) {
    setError('');
    setState((value) => ({
      ...value,
      profile: {
        ...value.profile,
        jobs: value.profile.jobs.includes(job)
          ? value.profile.jobs.filter((item) => item !== job)
          : [...value.profile.jobs, job],
      },
    }));
  }

  async function finish(final: OnboardingProfile) {
    if (saving) return;
    setSaving(true);
    setError('');
    setCanContinue(false);
    const capture = analyticsForCurrentSession();
    const saved = trimmed(final);
    try {
      await api('/api/onboarding/profile', { method: 'POST', body: JSON.stringify(saved) });
      capture('onboarding_profile_answered', onboardingProfileAnswers(saved));
      onNext();
    } catch (cause) {
      capture('ui_error', { area: 'onboarding', action: 'save' });
      setError(errorMessage(cause));
      setCanContinue(cause instanceof ApiError && cause.status === 502);
    } finally {
      setSaving(false);
    }
  }

  function choices(question: Question) {
    if (question === 'scope')
      return profileScopes.map((option) => (
        <Chip
          key={option.id}
          on={profile.scope === option.id}
          onClick={() => settle('scope', { ...profile, scope: option.id })}
        >
          {option.label}
        </Chip>
      ));
    if (question === 'size')
      return profileCompanySizes.map((option) => (
        <Chip
          key={option.id}
          on={profile.companySize === option.id}
          onClick={() => settle('size', { ...profile, companySize: option.id })}
        >
          {option.label}
        </Chip>
      ));
    if (question === 'whoFor')
      return profileWhoFor.map((option) => (
        <Chip
          key={option.id}
          on={profile.whoFor === option.id}
          onClick={() => settle('whoFor', { ...profile, whoFor: option.id })}
        >
          {option.label}
        </Chip>
      ));
    if (question === 'roles')
      return [
        ...profileRoles
          .filter((option) => !('personal' in option) || profile.scope === 'personal')
          .map((option) => (
            <Chip
              key={option.id}
              check
              on={profile.roles.includes(option.id)}
              onClick={() => toggleRole(option.id)}
            >
              {option.label}
            </Chip>
          )),
        <Other
          key="other"
          open={editing === 'roles' || Boolean(profile.roleText)}
          value={profile.roleText ?? ''}
          onOpen={() => setState((value) => ({ ...value, editing: 'roles' }))}
          onChange={(roleText) =>
            setState((value) => ({ ...value, profile: { ...value.profile, roleText } }))
          }
          onEnter={sendRoles}
          onAction={() =>
            setState((value) => ({
              ...value,
              editing: null,
              profile: { ...value.profile, roleText: undefined },
            }))
          }
        />,
      ];
    return [
      ...profileJobs.map((option) => (
        <Chip key={option.id} check on={has(option.id)} onClick={() => toggleJob(option.id)}>
          {option.label}
        </Chip>
      )),
      <Other
        key="other"
        open={editing === 'jobs' || Boolean(profile.jobsText)}
        value={profile.jobsText ?? ''}
        onOpen={() => setState((value) => ({ ...value, editing: 'jobs' }))}
        onChange={(jobsText) =>
          setState((value) => ({ ...value, profile: { ...value.profile, jobsText } }))
        }
        onEnter={sendJobs}
        onAction={() =>
          setState((value) => ({
            ...value,
            editing: null,
            profile: { ...value.profile, jobsText: undefined },
          }))
        }
      />,
    ];
  }

  const turns: ReactNode[] = [];
  for (const [index, question] of list.entries()) {
    const live = question === current;
    if (!live && !state.seen.includes(question)) break;
    if (live && typing) break;
    const first = index === 0;
    turns.push(
      <Messages
        key={`${question}-asked`}
        revealed={first ? intro.revealed : undefined}
        typing={first ? intro.typing : false}
        items={[
          ...(first
            ? [
                <Bubble>
                  <strong>Tell me a bit about yourself so I can help from day one.</strong>
                  {usageShared &&
                    ' I also share your answers with the Nod team to improve Nod. You can turn that off in Settings.'}
                </Bubble>,
              ]
            : []),
          <Bubble>
            <strong>{prompts[question]}</strong>
            {(question === 'roles' || question === 'jobs') && ' Pick as many as you like.'}
          </Bubble>,
        ]}
      />,
    );
    if (live) {
      turns.push(
        <Rise key="choices" show={!first || intro.done} className="ob-chips">
          {choices(question)}
        </Rise>,
      );
      break;
    }
    turns.push(
      <Reply
        key={`${question}-answered`}
        text={answer(question, profile) ?? 'Skipped'}
        onEdit={() => edit(question)}
        disabled={saving}
      />,
    );
  }
  if (typing) turns.push(<Messages key="typing" items={[]} typing />);

  const ready =
    current === 'done'
      ? () => void finish(profile)
      : current === 'jobs' && (profile.jobs.length || profile.jobsText?.trim())
        ? sendJobs
        : current === 'roles' && (profile.roles.length || profile.roleText?.trim())
          ? sendRoles
          : undefined;

  return (
    <section
      className="ob-step ob-about"
      data-analytics-public
      onClick={intro.done ? undefined : intro.skip}
    >
      {turns}
      {error && (
        <div className="ob-about-error">
          <Notice>{error}</Notice>
        </div>
      )}
      <div ref={end} />
      <Footer
        onBack={onBack}
        onSkip={current === 'done' ? (canContinue ? onNext : undefined) : () => skip(current)}
        skipLabel={current === 'done' ? 'Continue anyway' : 'Not now'}
        onNext={ready}
        busy={saving}
      />
    </section>
  );
}
