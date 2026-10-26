import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';

export function ConnectionMenu({
  label,
  children,
  trigger,
  triggerClassName,
  compact = false,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: {
  label: string;
  children(close: () => void): ReactNode;
  trigger: ReactNode;
  triggerClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  };
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const close = () => {
    setOpen(false);
    queueMicrotask(() => {
      const button = container.current?.querySelector<HTMLButtonElement>(':scope > button');
      pendingFocus.current = Boolean(button?.disabled);
      button?.focus();
    });
  };
  useEffect(() => {
    if (disabled || !pendingFocus.current) return;
    pendingFocus.current = false;
    if (document.activeElement === document.body)
      container.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: Event) => {
      if (!event.composedPath().includes(container.current!)) setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('click', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('click', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('blur', blur);
    };
  }, [open]);
  return (
    <div
      className={`connection-menu ${compact ? 'connection-account-menu' : ''}`}
      ref={container}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Tab') {
          setOpen(false);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role^="menuitem"]:not(:disabled)',
          ),
        ];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : event.key === 'ArrowDown'
                ? (current + 1) % items.length
                : event.key === 'ArrowUp'
                  ? (current - 1 + items.length) % items.length
                  : -1;
        if (next >= 0) {
          event.preventDefault();
          items[next]?.focus();
        }
      }}
    >
      <Button
        className={triggerClassName}
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'icon' : 'sm'}
        aria-label={label}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (!open && event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </Button>
      {open && (
        <div className="connection-menu-options menu" role="menu" aria-label={label} id={menuId}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
