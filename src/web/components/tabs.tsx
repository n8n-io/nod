import { useRef, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../lib/utils';

export function Tabs<Value extends string>({
  id,
  panelId,
  label,
  items,
  value,
  onValueChange,
  variant = 'pills',
  size = 'default',
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  id: string;
  panelId: string;
  label: string;
  items: readonly { value: Value; label: ReactNode; count?: number; disabled?: boolean }[];
  value: Value;
  onValueChange(value: NoInfer<Value>): boolean | void;
  variant?: 'pills' | 'underline';
  size?: 'default' | 'compact';
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const selected = items.findIndex((item) => item.value === value && !item.disabled);
  const reachable = selected < 0 ? items.findIndex((item) => !item.disabled) : selected;

  function focus(index: number) {
    const bar = list.current;
    const button = bar?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index];
    if (!bar || !button) return;
    button.focus({ preventScroll: true });
    const edge = bar.getBoundingClientRect();
    const target = button.getBoundingClientRect();
    if (target.left < edge.left) bar.scrollLeft += target.left - edge.left;
    else if (target.right > edge.right) bar.scrollLeft += target.right - edge.right;
  }

  function select(index: number, moveFocus: boolean) {
    const item = items[index];
    if (!item || item.disabled) return;
    if (onValueChange(item.value) === false) {
      focus(reachable);
      return;
    }
    if (moveFocus) focus(index);
  }

  return (
    <div
      {...props}
      ref={list}
      className={cn('tabs', `tabs-${variant}`, size === 'compact' && 'tabs-compact', className)}
      role="tablist"
      aria-label={label}
    >
      {items.map((item, index) => (
        <button
          key={item.value}
          id={`${id}-${item.value}`}
          type="button"
          role="tab"
          className="tabs-tab"
          aria-selected={value === item.value}
          aria-controls={panelId}
          tabIndex={index === reachable ? 0 : -1}
          disabled={item.disabled}
          onClick={() => select(index, false)}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const enabled = items.flatMap((entry, position) => (entry.disabled ? [] : [position]));
            const current = enabled.indexOf(index);
            const next =
              event.key === 'ArrowRight'
                ? enabled[(current + 1) % enabled.length]
                : event.key === 'ArrowLeft'
                  ? enabled[(current - 1 + enabled.length) % enabled.length]
                  : event.key === 'Home'
                    ? enabled[0]
                    : event.key === 'End'
                      ? enabled.at(-1)
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            select(next, true);
          }}
        >
          {item.label}
          {item.count !== undefined && <span className="tabs-count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
