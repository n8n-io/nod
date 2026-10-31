import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import { cn } from '../lib/utils';

function menuItems(element: HTMLElement) {
  return Array.from(
    element.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    ),
  ).filter((item) => item.closest('[role="menu"]') === element && item.getClientRects().length);
}

function revealMenuItem(item: HTMLElement) {
  const menu = item.closest<HTMLElement>('[role="menu"]');
  if (!menu) return;
  const bounds = menu.getBoundingClientRect();
  const row = item.getBoundingClientRect();
  const top = bounds.top + menu.clientTop;
  const bottom = top + menu.clientHeight;
  if (row.top < top) menu.scrollTop -= top - row.top;
  else if (row.bottom > bottom) menu.scrollTop += row.bottom - bottom;
}

export function focusActionMenuItem(item: HTMLElement | null | undefined) {
  if (!item) return;
  item.focus({ preventScroll: true });
  revealMenuItem(item);
}

export function useActionMenuViewport(ref: Ref<HTMLDivElement> | undefined) {
  return useCallback(
    (node: HTMLDivElement | null) => {
      const cleanup = typeof ref === 'function' ? ref(node) : undefined;
      if (ref && typeof ref !== 'function') ref.current = node;
      if (!node) return;
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => {
              const item = document.activeElement;
              if (item instanceof HTMLElement && item.closest('[role="menu"]') === node)
                revealMenuItem(item);
            });
      observer?.observe(node);
      return () => {
        observer?.disconnect();
        if (typeof cleanup === 'function') cleanup();
        else if (typeof ref === 'function') ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref],
  );
}

export function actionMenuTabTarget(
  trigger: HTMLElement | null | undefined,
  backward: boolean,
  menu: HTMLElement | null | undefined,
) {
  if (!trigger) return null;
  const scope = trigger.closest('[role="dialog"]') ?? document.body;
  const items = Array.from(
    scope.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]'),
  ).filter(
    (item) =>
      item.tabIndex >= 0 &&
      !item.matches(':disabled') &&
      !item.hasAttribute('data-radix-focus-guard') &&
      !item.closest('[hidden],[inert]') &&
      !menu?.contains(item) &&
      item.getClientRects().length > 0 &&
      getComputedStyle(item).visibility !== 'hidden',
  );
  const index = items.indexOf(trigger);
  return items[index + (backward ? -1 : 1)] ?? trigger;
}

export function useActionMenuNavigation(active = true) {
  const search = useRef({ text: '', time: 0 });
  useEffect(() => {
    search.current = { text: '', time: 0 };
  }, [active]);
  return (event: KeyboardEvent<HTMLElement>) => {
    if (
      !active ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target instanceof Element &&
        event.target.closest('input,textarea,[contenteditable="true"]'))
    )
      return;
    const items = menuItems(event.currentTarget);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : event.key === 'ArrowUp'
              ? index < 0
                ? items.length - 1
                : (index - 1 + items.length) % items.length
              : -1;
    if (next >= 0) {
      event.preventDefault();
      focusActionMenuItem(items[next]);
      return;
    }
    if (event.key.length !== 1 || event.key === ' ') return;
    const now = performance.now();
    const text = `${now - search.current.time < 700 ? search.current.text : ''}${event.key}`;
    search.current = { text, time: now };
    const query = (new Set(text.toLocaleLowerCase()).size === 1 ? text[0] : text)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase();
    const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
    const match = ordered.find((item) =>
      (
        item.dataset.textValue ??
        (item.textContent?.trim() || item.getAttribute('aria-label') || '')
      )
        .trim()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase()
        .startsWith(query),
    );
    if (match) {
      event.preventDefault();
      focusActionMenuItem(match);
    }
  };
}

export function ActionMenuSurface({ className, onKeyDown, ref, ...props }: ComponentProps<'div'>) {
  const navigate = useActionMenuNavigation();
  const observe = useActionMenuViewport(ref);
  return (
    <div
      {...props}
      ref={observe}
      role="menu"
      className={cn('menu action-menu-surface', className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        navigate(event);
      }}
    />
  );
}

export function ActionMenuItem({
  className,
  checked,
  destructive,
  textValue,
  onClick,
  ...props
}: ComponentProps<'button'> & {
  checked?: boolean;
  destructive?: boolean;
  textValue?: string;
}) {
  return (
    <button
      {...props}
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      data-destructive={destructive || undefined}
      data-text-value={textValue}
      className={cn('action-menu-item', className)}
      onClick={(event) => {
        if (
          props.disabled ||
          props['aria-disabled'] === true ||
          props['aria-disabled'] === 'true'
        ) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}

export function ActionMenu({
  label,
  trigger,
  children,
  open: controlledOpen,
  onOpenChange,
  disabled = false,
  align = 'end',
  side = 'bottom',
  matchTriggerWidth = false,
  className,
  contentClassName,
  onCloseAutoFocus,
}: {
  label: string;
  trigger: ReactElement;
  children: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean;
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  matchTriggerWidth?: boolean;
  className?: string;
  contentClassName?: string;
  onCloseAutoFocus?: ComponentProps<typeof Popover.Content>['onCloseAutoFocus'];
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(true);
  const pendingFocus = useRef(false);
  const tabTarget = useRef<HTMLElement | null>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const changeOpen = (next: boolean) => {
    if (next && disabled) return;
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (disabled && open) changeOpen(false);
    if (!disabled && pendingFocus.current) {
      pendingFocus.current = false;
      if (document.activeElement === document.body)
        triggerRef.current?.focus({ preventScroll: true });
    }
  }, [disabled, open]);
  useEffect(() => {
    if (!open) return;
    const blur = () => {
      returnFocus.current = false;
      changeOpen(false);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [open]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <span
        className={cn('action-menu-root', className)}
        data-match-trigger={matchTriggerWidth || undefined}
      >
        <Popover.Trigger
          asChild
          ref={triggerRef}
          disabled={disabled}
          aria-label={label}
          aria-haspopup="menu"
          aria-controls={open ? id : undefined}
          onKeyDown={(event) => {
            if (
              open ||
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              !['ArrowDown', 'ArrowUp'].includes(event.key)
            )
              return;
            event.preventDefault();
            initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
            changeOpen(true);
          }}
        >
          {trigger}
        </Popover.Trigger>
      </span>
      <Popover.Portal>
        <Popover.Content
          asChild
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current = true;
            tabTarget.current = null;
            const items = content.current ? menuItems(content.current) : [];
            const selected = items.find((item) => item.getAttribute('aria-checked') === 'true');
            focusActionMenuItem(
              selected ?? (initialFocus.current === 'last' ? items.at(-1) : items[0]),
            );
            initialFocus.current = 'first';
          }}
          onInteractOutside={() => {
            returnFocus.current = false;
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            const target = tabTarget.current;
            tabTarget.current = null;
            if (!returnFocus.current) return;
            if (target?.isConnected) target.focus({ preventScroll: true });
            else if (triggerRef.current?.disabled) pendingFocus.current = true;
            else triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <ActionMenuSurface
            ref={content}
            id={id}
            aria-label={label}
            className={contentClassName}
            data-match-trigger={matchTriggerWidth || undefined}
            onKeyDownCapture={(event) => {
              if (
                event.key !== 'Tab' ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.nativeEvent.isComposing
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              tabTarget.current = actionMenuTabTarget(
                triggerRef.current,
                event.shiftKey,
                content.current,
              );
              changeOpen(false);
            }}
          >
            {typeof children === 'function' ? children(() => changeOpen(false)) : children}
          </ActionMenuSurface>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
