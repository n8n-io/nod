import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { OttoGlyph, prefersReducedMotion, Rise } from '../../components/motion';
import { Button } from '../../components/ui';
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
  return {
    revealed: state.revealed,
    typing: state.typing,
    done: state.revealed >= total,
    played: state.played,
    replay: () => setRun((value) => value + 1),
    skip: () => {
      pending.current.forEach(clearTimeout);
      setState((current) => ({ ...current, revealed: total, typing: false }));
    },
  };
}

export function Bubble({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ob-bubble', className)} {...props} />;
}

export function UserBubble({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('ob-bubble ob-user-bubble', className)} data-analytics-private {...props} />
  );
}

function Typing() {
  return (
    <div className="ob-bubble ob-typing" role="status" aria-label="Otto is typing">
      <span />
      <span />
      <span />
    </div>
  );
}

export function Grow({
  open,
  animate = true,
  children,
}: {
  open: boolean;
  animate?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="ob-grow"
      data-open={open}
      data-animate={animate}
      aria-hidden={!open}
      inert={!open}
    >
      <div>{children}</div>
    </div>
  );
}

function OttoRow({
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
          <OttoGlyph mode={thinking ? 'thinking' : 'idle'} />
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
}: {
  items: ReactNode[];
  revealed?: number;
  typing?: boolean;
  avatar?: ReactNode;
  className?: string;
}) {
  return (
    <OttoRow thinking={typing} avatar={avatar} className={className}>
      {items.map((item, index) => (
        <Grow key={index} open={index < revealed}>
          {item}
        </Grow>
      ))}
      <Grow open={typing} animate={false}>
        <Typing />
      </Grow>
    </OttoRow>
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
}) {
  return (
    <Rise show={show} className="ob-footer" data-analytics-public>
      {onBack && (
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {backLabel}
        </Button>
      )}
      <div className="ob-footer-end">
        {onSkip && (
          <Button variant="ghost" onClick={onSkip} disabled={busy}>
            {skipLabel}
          </Button>
        )}
        <Button className="ob-next" onClick={onNext} disabled={nextDisabled || busy}>
          {nextLabel}
        </Button>
      </div>
    </Rise>
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
