import {
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { ChevronDown } from '../../components/icons';
import { NodGlyph, prefersReducedMotion } from '../../components/motion';
import { Button, Switch } from '../../components/ui';
import { cn } from '../../lib/utils';

export type RevealStep = { wait?: number; typing?: number };

export function useReveal(
  sequence: readonly RevealStep[],
  { enabled = true, open = false }: { enabled?: boolean; open?: boolean } = {},
) {
  const total = sequence.length;
  const opening = open && Boolean(sequence[0]?.typing && !sequence[0]?.wait);
  const [state, setState] = useState(() => ({
    revealed: enabled && !prefersReducedMotion() ? 0 : total,
    typing: enabled && opening && !prefersReducedMotion(),
    played: false,
  }));
  const [run, setRun] = useState(0);
  const pending = useRef<number[]>([]);
  const signature = sequence.map((step) => `${step.wait ?? 0}:${step.typing ?? 0}`).join();
  useEffect(() => {
    if (prefersReducedMotion() || (!enabled && !run)) {
      setState({ revealed: total, typing: false, played: false });
      return;
    }
    setState({ revealed: 0, typing: opening, played: true });
    const timers: number[] = (pending.current = []);
    let at = 0;
    sequence.forEach((step, index) => {
      at += step.wait ?? 0;
      if (step.typing) {
        timers.push(
          window.setTimeout(() => setState({ revealed: index, typing: true, played: true }), at),
        );
        at += step.typing;
      }
      timers.push(
        window.setTimeout(() => setState({ revealed: index + 1, typing: false, played: true }), at),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, [enabled, run, signature]);
  const done = state.revealed >= total;
  const skip = () => {
    pending.current.forEach(clearTimeout);
    setState((current) => ({ ...current, revealed: total, typing: false }));
  };
  useEffect(() => {
    if (done) return;
    const press = (event: KeyboardEvent) => {
      const surface =
        event.target === document.body || event.target === document.querySelector('.ob-main');
      if (event.key === 'Enter' && surface && !event.repeat) skip();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [done]);
  return {
    revealed: state.revealed,
    typing: state.typing,
    done,
    played: state.played,
    replay: () => setRun((value) => value + 1),
    skip,
  };
}

export function Bubble({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ob-bubble', className)} {...props} />;
}

export function PreferenceBubble({
  children,
  label,
  link,
  checked,
  saving,
  disabled,
  error,
  onChange,
}: {
  children: ReactNode;
  label: string;
  link?: ReactNode;
  checked: boolean;
  saving: boolean;
  disabled?: boolean;
  error: string;
  onChange(value: boolean): void;
}) {
  const id = useId();
  return (
    <Bubble onClick={(event) => event.stopPropagation()}>
      <p id={`${id}-reason`}>{children}</p>
      <div className="ob-preference-toggle">
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          aria-busy={saving}
          aria-describedby={`${id}-reason`}
          onCheckedChange={onChange}
        />
        <span>
          <label htmlFor={id}>{label}</label>
          {link && <> · {link}</>}
        </span>
      </div>
      {error && (
        <p className="ob-preference-error" role="alert">
          {error}
        </p>
      )}
    </Bubble>
  );
}

export function UserBubble({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('ob-bubble ob-user-bubble', className)} data-analytics-private {...props} />
  );
}

function Typing({ on = true }: { on?: boolean }) {
  return (
    <div
      className="ob-bubble ob-typing"
      data-on={on}
      role={on ? 'status' : undefined}
      aria-label={on ? 'nod is typing' : undefined}
      aria-hidden={!on}
    >
      <span />
      <span />
      <span />
    </div>
  );
}

export function Grow({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="ob-grow" data-open={open} aria-hidden={!open} inert={!open}>
      <div>{children}</div>
    </div>
  );
}

function NodRow({
  thinking = false,
  avatar,
  children,
  className,
}: {
  thinking?: boolean;
  avatar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('ob-row', className)}>
      {avatar ?? (
        <span className="ob-avatar">
          <NodGlyph mode={thinking ? 'thinking' : 'idle'} />
        </span>
      )}
      <div className="ob-stack">{children}</div>
    </div>
  );
}

export function Messages({
  items,
  revealed = items.length,
  typing = false,
  avatar,
  className,
  conversation = false,
}: {
  items: ReactNode[];
  revealed?: number;
  typing?: boolean;
  avatar?: ReactNode;
  className?: string;
  conversation?: boolean;
}) {
  return (
    <NodRow
      thinking={typing}
      avatar={avatar}
      className={cn(!conversation && 'ob-intro', className)}
    >
      {items.map((item, index) =>
        conversation ? (
          <Grow key={index} open={index < revealed}>
            {item}
          </Grow>
        ) : (
          <div key={index} className="ob-message">
            <div
              className="ob-message-content"
              data-show={index < revealed}
              aria-hidden={index >= revealed}
              inert={index >= revealed}
            >
              {item}
            </div>
            <Typing on={typing && index === revealed} />
          </div>
        ),
      )}
      {conversation ? (
        <Grow open={typing}>
          <Typing />
        </Grow>
      ) : (
        typing && !items.length && <Typing />
      )}
    </NodRow>
  );
}

export function Footer({
  show = true,
  onBack,
  backLabel = 'Back',
  onSkip,
  skipLabel = 'Skip for now',
  onNext,
  nextLabel = 'Continue',
  nextDisabled = false,
  busy = false,
  summary,
}: {
  show?: boolean;
  onBack?(): void;
  backLabel?: string;
  onSkip?(): void;
  skipLabel?: string;
  onNext(): void;
  nextLabel?: ReactNode;
  nextDisabled?: boolean;
  busy?: boolean;
  summary?: ReactNode;
}) {
  return (
    <div className="ob-footer" data-analytics-public>
      {onBack && (
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {backLabel}
        </Button>
      )}
      <div className="ob-footer-end">
        {summary && <div className="ob-footer-summary">{summary}</div>}
        {onSkip && (
          <Button variant="ghost" onClick={onSkip} disabled={!show || busy}>
            {skipLabel}
          </Button>
        )}
        <Button className="ob-next" onClick={onNext} disabled={!show || nextDisabled || busy}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn('ob-select', className)}>
      <select className="input" {...props} />
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}
