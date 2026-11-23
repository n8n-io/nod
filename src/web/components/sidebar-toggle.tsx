import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import { shortcutLabel } from '../lib/navigation';
import { desktopSettingsAvailable } from '../lib/desktop';

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }) {
  const boundary = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const hold = useRef<() => void>(() => {});
  const [revealed, setRevealed] = useState(false);
  const desktop = desktopSettingsAvailable();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  useEffect(() => {
    const edge = boundary.current;
    const control = button.current;
    const shell = edge?.closest<HTMLElement>('.app-shell');
    if (!edge || !control || !shell) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let pointer: { x: number; y: number } | undefined;
    let near = false;
    let shown = false;
    let dismissed = false;
    let heldUntil = 0;
    const clear = () => {
      clearTimeout(revealTimer);
      clearTimeout(hideTimer);
      revealTimer = undefined;
      hideTimer = undefined;
    };
    const focused = () => control.matches(':focus-visible');
    const nearPointer = () => {
      if (!pointer || !control.getClientRects().length) return false;
      const bounds = edge.getBoundingClientRect();
      return (
        pointer.y >= bounds.top &&
        pointer.y <= bounds.bottom &&
        Math.abs(pointer.x - (bounds.left + bounds.width / 2)) <= 32
      );
    };
    const show = () => {
      clearTimeout(revealTimer);
      revealTimer = undefined;
      if (heldUntil <= performance.now()) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      shown = true;
      setRevealed(true);
    };
    const hide = () => {
      clear();
      shown = false;
      setRevealed(false);
    };
    const queueHide = () => {
      clear();
      hideTimer = setTimeout(
        () => {
          hideTimer = undefined;
          near = nearPointer();
          if (!dismissed && (near || focused())) return;
          hide();
        },
        Math.max(reducedMotion.matches ? 0 : 300, heldUntil - performance.now()),
      );
    };
    const updatePointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      const next = nearPointer();
      if (next === near) return;
      near = next;
      if (!near) {
        dismissed = false;
        queueHide();
        return;
      }
      if (heldUntil <= performance.now()) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      if (dismissed || shown || revealTimer) return;
      revealTimer = setTimeout(
        () => {
          revealTimer = undefined;
          near = nearPointer();
          if (near && !dismissed) show();
        },
        reducedMotion.matches ? 0 : 120,
      );
    };
    const leave = () => {
      pointer = undefined;
      near = false;
      dismissed = false;
      queueHide();
    };
    const enterControl = (event: PointerEvent) => {
      updatePointer(event);
      if (!dismissed) show();
    };
    const focus = () => {
      dismissed = false;
      show();
    };
    const reset = () => {
      pointer = undefined;
      near = false;
      dismissed = false;
      heldUntil = 0;
      hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !shown) return;
      if (document.activeElement === control) {
        event.preventDefault();
        document.getElementById('workspace')?.focus({ preventScroll: true });
      }
      heldUntil = 0;
      dismissed = nearPointer();
      hide();
    };
    const motionChanged = () => {
      heldUntil = 0;
      if (nearPointer() || focused()) show();
      else hide();
    };
    hold.current = () => {
      if (!shown && !focused()) {
        clear();
        near = false;
        dismissed = false;
        return;
      }
      dismissed = false;
      show();
      heldUntil = performance.now() + (reducedMotion.matches ? 0 : 360);
      queueHide();
    };
    shell.addEventListener('pointermove', updatePointer);
    shell.addEventListener('pointerleave', leave);
    control.addEventListener('pointerenter', enterControl);
    control.addEventListener('pointerleave', updatePointer);
    control.addEventListener('focus', focus);
    control.addEventListener('blur', queueHide);
    window.addEventListener('blur', reset);
    window.addEventListener('resize', reset);
    window.addEventListener('keydown', escape);
    reducedMotion.addEventListener('change', motionChanged);
    return () => {
      clear();
      hold.current = () => {};
      shell.removeEventListener('pointermove', updatePointer);
      shell.removeEventListener('pointerleave', leave);
      control.removeEventListener('pointerenter', enterControl);
      control.removeEventListener('pointerleave', updatePointer);
      control.removeEventListener('focus', focus);
      control.removeEventListener('blur', queueHide);
      window.removeEventListener('blur', reset);
      window.removeEventListener('resize', reset);
      window.removeEventListener('keydown', escape);
      reducedMotion.removeEventListener('change', motionChanged);
    };
  }, []);
  useEffect(() => hold.current(), [collapsed]);
  return (
    <div className="sidebar-edge" ref={boundary} data-revealed={revealed || undefined}>
      <Button
        ref={button}
        type="button"
        variant="ghost"
        size="icon"
        className="sidebar-edge-toggle"
        aria-label={label}
        title={label}
        shortcut={desktop ? shortcutLabel('b', mac) : undefined}
        tooltipSide="right"
        tooltipDelay={100}
        aria-expanded={!collapsed}
        aria-controls="sidebar-navigation"
        aria-keyshortcuts={desktop ? `${mac ? 'Meta' : 'Control'}+B` : undefined}
        onClick={onToggle}
      >
        <span className="sidebar-edge-face" aria-hidden="true">
          <svg
            className="sidebar-edge-symbol"
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
          >
            <rect x="1.75" y="2.75" width="14.5" height="12.5" rx="2.75" />
            <path className="sidebar-edge-symbol-divider" d="M7.75 3.5v11" />
          </svg>
        </span>
      </Button>
    </div>
  );
}
