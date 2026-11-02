import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  profileCompanySizes,
  profileJobs,
  profileRoles,
  profileScopes,
  profileTextChars,
  type OnboardingProfile,
  type ProfileJob,
} from '../../../../shared/onboarding';
import { ArrowRight, Check, Pencil, X } from '../../../components/icons';
import { prefersReducedMotion, Rise } from '../../../components/motion';
import { api } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal } from '../motion';
import { readStored, writeStored } from '../storage';

type Question = 'scope' | 'role' | 'size' | 'jobs';
type State = {
  current: Question | 'done';
  seen: Question[];
  profile: OnboardingProfile;
  editing: 'role' | 'jobs' | null;
};

const prompts: Record<Question, string> = {
  scope: 'Where would you like my help?',
  role: 'What do you do?',
  size: 'How big is your company?',
  jobs: 'What would you like to take off your plate?',
};

const fresh: State = { current: 'scope', seen: [], profile: { jobs: [] }, editing: null };

function questions(profile: OnboardingProfile): Question[] {
  return profile.scope === 'personal'
    ? ['scope', 'role', 'jobs']
    : ['scope', 'role', 'size', 'jobs'];
}

function label(list: readonly { id: string; label: string }[], id?: string) {
  return list.find((item) => item.id === id)?.label;
}

function answer(question: Question, profile: OnboardingProfile) {
  if (question === 'scope') return label(profileScopes, profile.scope);
  if (question === 'role') return profile.roleText || label(profileRoles, profile.role);
  if (question === 'size') return label(profileCompanySizes, profile.companySize);
  return (
    [...profile.jobs.map((job) => label(profileJobs, job)), profile.jobsText]
      .filter(Boolean)
      .join(', ') || undefined
  );
}

function restore(): State | undefined {
  const stored = readStored<State>('about');
  return stored?.profile && Array.isArray(stored.seen) && Array.isArray(stored.profile.jobs)
    ? { ...stored, editing: null }
    : undefined;
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
  submit,
  onOpen,
  onChange,
  onEnter,
  onAction,
}: {
  open: boolean;
  value: string;
  submit: boolean;
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
          if (event.key === 'Enter') onEnter();
        }}
      />
      <button
        type="button"
        className={cn('ob-chip-action', submit && 'ob-chip-send')}
        aria-label={submit ? 'Send' : 'Close'}
        onClick={onAction}
      >
        {submit ? <ArrowRight size={18} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
      </button>
    </span>
  );
}

function Reply({ text, onEdit }: { text: string; onEdit(): void }) {
  return (
    <div className="ob-reply">
      <button type="button" className="ob-reply-edit" aria-label="Edit answer" onClick={onEdit}>
        <Pencil size={16} aria-hidden="true" />
      </button>
      <div className="ob-bubble ob-user-bubble" data-analytics-private>
        {text}
      </div>
    </div>
  );
}

export function About({ arrived, quiet, onNext, onBack }: StepProps) {
  const [restored] = useState(restore);
  const [state, setState] = useState<State>(() => restored ?? fresh);
  const [draft, setDraft] = useState(() => restored?.profile.roleText ?? '');
  const [typing, setTyping] = useState(false);
  const [saving, setSaving] = useState(false);
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
  }, [current, typing]);

  function settle(question: Question, next: OnboardingProfile) {
    const seen = state.seen.includes(question) ? state.seen : [...state.seen, question];
    const upcoming = questions(next).find((item) => !seen.includes(item)) ?? 'done';
    setState({ current: upcoming, seen, profile: next, editing: null });
    if (upcoming === 'done') return void finish(next);
    if (prefersReducedMotion()) return;
    window.clearTimeout(timer.current);
    setTyping(true);
    timer.current = window.setTimeout(() => setTyping(false), 900);
  }

  function edit(question: Question) {
    window.clearTimeout(timer.current);
    setTyping(false);
    setState((value) => ({ ...value, current: question, editing: null }));
  }

  function sendRole() {
    const text = draft.trim();
    if (text) settle('role', { ...profile, role: undefined, roleText: text });
  }

  function trimmed(value: OnboardingProfile): OnboardingProfile {
    return { ...value, jobsText: value.jobsText?.trim() || undefined };
  }

  function sendJobs() {
    settle('jobs', trimmed(profile));
  }

  function toggle(job: ProfileJob) {
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
    const capture = analyticsForCurrentSession();
    const asked = questions(final);
    const saved: OnboardingProfile = {
      ...final,
      companySize: asked.includes('size') ? final.companySize : undefined,
    };
    const chose = (job: ProfileJob) => final.jobs.includes(job);
    capture('onboarding_profile_answered', {
      scope: final.scope ?? 'skipped',
      role: final.roleText ? 'other' : (final.role ?? 'skipped'),
      company_size: asked.includes('size') ? (final.companySize ?? 'skipped') : 'not_asked',
      job_email: chose('email'),
      job_calendar: chose('calendar'),
      job_follow_ups: chose('follow_ups'),
      job_errands: chose('errands'),
      job_research: chose('research'),
      job_routines: chose('routines'),
      job_other: Boolean(final.jobsText),
    });
    await api('/api/onboarding/profile', { method: 'POST', body: JSON.stringify(saved) }).catch(
      () => capture('ui_error', { area: 'onboarding', action: 'save' }),
    );
    setSaving(false);
    onNext();
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
    if (question === 'role')
      return [
        ...profileRoles
          .filter((option) => !('personal' in option) || profile.scope === 'personal')
          .map((option) => (
            <Chip
              key={option.id}
              on={!profile.roleText && profile.role === option.id}
              onClick={() => settle('role', { ...profile, role: option.id, roleText: undefined })}
            >
              {option.label}
            </Chip>
          )),
        <Other
          key="other"
          open={editing === 'role'}
          value={draft}
          submit
          onOpen={() => setState((value) => ({ ...value, editing: 'role' }))}
          onChange={setDraft}
          onEnter={sendRole}
          onAction={sendRole}
        />,
      ];
    return [
      ...profileJobs.map((option) => (
        <Chip key={option.id} check on={has(option.id)} onClick={() => toggle(option.id)}>
          {option.label}
        </Chip>
      )),
      <Other
        key="other"
        open={editing === 'jobs' || Boolean(profile.jobsText)}
        value={profile.jobsText ?? ''}
        submit={false}
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
                  Can you tell me a bit about yourself? The more I know about you, the more useful I
                  can be from day one.
                </Bubble>,
              ]
            : []),
          <Bubble>
            <strong>{prompts[question]}</strong>
            {question === 'jobs' && ' Pick as many as you like.'}
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
      />,
    );
  }
  if (typing) turns.push(<Messages key="typing" items={[]} typing />);

  const ready =
    current === 'done'
      ? () => void finish(profile)
      : current === 'jobs' && (profile.jobs.length || profile.jobsText?.trim())
        ? sendJobs
        : current === 'role' && editing === 'role' && draft.trim()
          ? sendRole
          : undefined;

  return (
    <section
      className="ob-step ob-about"
      data-analytics-public
      onClick={intro.done ? undefined : intro.skip}
    >
      {turns}
      <div ref={end} />
      <Footer
        onBack={onBack}
        onSkip={current === 'done' ? undefined : () => settle(current, trimmed(profile))}
        skipLabel="Not now"
        onNext={ready}
        busy={saving}
      />
    </section>
  );
}
