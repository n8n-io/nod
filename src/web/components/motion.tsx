import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { cn } from '../lib/utils';

export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

type GlyphReaction = { kind: 'on' | 'off'; count: number };

const orbitRadius = Math.hypot(9, 10);
const orbitStart = (Math.atan2(-10, 9) * 180) / Math.PI;
const orbitLength = 2 * Math.PI * orbitRadius;

export function NodGlyph({
  size = 32,
  mode = 'idle',
  reaction,
  className,
  progress,
  waiting = false,
}: {
  size?: number;
  mode?: 'idle' | 'thinking' | 'still' | 'bounce';
  reaction?: GlyphReaction | null;
  className?: string;
  progress?: number;
  waiting?: boolean;
}) {
  const orbiting = progress !== undefined;
  const thinking = mode === 'thinking';
  const [phase, setPhase] = useState<'rest' | 'spin' | 'settle'>(thinking ? 'spin' : 'rest');
  const live = useRef({ thinking, since: 0 });
  useEffect(() => {
    live.current = { thinking, since: performance.now() };
    if (prefersReducedMotion()) setPhase(thinking ? 'spin' : 'rest');
    else if (thinking) setPhase((current) => (current === 'rest' ? 'spin' : current));
  }, [thinking]);
  const circle = (
    <circle
      cx="25"
      cy="6"
      r="4"
      className={cn(
        mode === 'idle' && phase === 'rest' && 'ob-glyph-pulse',
        orbiting && (waiting ? 'ob-glyph-waiting' : progress < 1 && 'ob-glyph-receiving'),
      )}
      fill="var(--brand-pink)"
    />
  );
  const dot = reaction ? (
    <g key={reaction.count} className="ob-glyph-react" data-reaction={reaction.kind}>
      {circle}
    </g>
  ) : (
    circle
  );
  return (
    <svg
      className={cn(
        'ob-glyph',
        mode === 'bounce' && !orbiting && 'ob-glyph-bounce',
        orbiting && 'ob-glyph-orbiting',
        className,
      )}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
    >
      {orbiting && (
        <>
          <circle className="ob-glyph-track" cx="16" cy="16" r={orbitRadius} />
          {progress > 0 && (
            <circle
              className="ob-glyph-trail"
              cx="16"
              cy="16"
              r={orbitRadius}
              transform={`rotate(${orbitStart} 16 16)`}
              strokeDasharray={`${orbitLength * progress} ${orbitLength}`}
            />
          )}
        </>
      )}
      <circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="4" />
      <g
        className="ob-glyph-orbit"
        data-phase={phase}
        style={orbiting ? { transform: `rotate(${progress * 360}deg)` } : undefined}
        onAnimationIteration={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.animationName !== 'ob-spin' ||
            live.current.thinking
          )
            return;
          if (performance.now() - live.current.since > 600) setPhase('settle');
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === 'ob-spin-out')
            setPhase(live.current.thinking ? 'spin' : 'rest');
        }}
      >
        {dot}
      </g>
    </svg>
  );
}

export function Rise({
  show = true,
  index = 0,
  className,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { show?: boolean; index?: number }) {
  return (
    <div
      className={cn('ob-rise', className)}
      data-show={show}
      inert={!show}
      style={{ '--rise-delay': `${index * 70}ms`, ...style } as CSSProperties}
      {...props}
    />
  );
}
