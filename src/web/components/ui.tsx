import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle, Search, X } from './icons';
import { cn } from '../lib/utils';

const buttonVariants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      outline: 'button-outline',
      destructive: 'button-destructive',
    },
    size: { default: 'button-default', sm: 'button-sm', icon: 'button-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn('input', className)} {...props} />
));
Input.displayName = 'Input';
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn('dialog-content', className)} {...props}>
        {children}
        <DialogPrimitive.Close
          className="button button-ghost button-icon dialog-close"
          aria-label="Close"
        >
          <X size={16} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SearchField({
  className,
  inputRef,
  onClear,
  clearLabel = 'Clear search',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  inputRef?: React.Ref<HTMLInputElement>;
  onClear?: () => void;
  clearLabel?: string;
}) {
  return (
    <div className={cn('search-field', className)}>
      <Search size={16} aria-hidden="true" />
      <Input ref={inputRef} {...props} />
      {onClear && props.value ? (
        <Button type="button" variant="ghost" size="icon" aria-label={clearLabel} onClick={onClear}>
          <X size={16} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
export function Switch({
  className,
  checked,
  onCheckedChange,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn('switch', className)}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
    >
      <span />
    </button>
  );
}
export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="checkbox" className={cn('checkbox', className)} />;
}

export function Notice({
  children,
  kind = 'error',
  onDismiss,
}: {
  children: React.ReactNode;
  kind?: 'error' | 'info' | 'success';
  onDismiss?(): void;
}) {
  return (
    <div
      className={cn('notice', `notice-${kind}`, onDismiss && 'notice-dismissible')}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="notice-dismiss"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const element = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const page = element.current?.closest<HTMLElement>('.secondary-page');
    const shown = performance.now();
    return () => {
      if (!page || performance.now() - shown <= 300) return;
      page.dataset.reveal = 'true';
      setTimeout(() => delete page.dataset.reveal, 700);
    };
  }, []);
  return (
    <div className="loading" ref={element}>
      <span className="loading-ghost" aria-hidden="true">
        {[58, 44, 51].map((width) => (
          <span key={width} className="resource-row">
            <Skeleton className="ghost-icon" />
            <span className="skeleton-lines">
              <Skeleton style={{ width: `${width}%` }} />
              <Skeleton style={{ width: `${width - 20}%` }} />
            </span>
          </span>
        ))}
      </span>
      <span className="loading-label">
        <LoaderCircle size={16} className="spin" />
        <span>{label}</span>
      </span>
    </div>
  );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden="true" className={cn('skeleton', className)} {...props} />;
}
