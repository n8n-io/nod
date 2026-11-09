import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle, Search, X } from './icons';
import { cn } from '../lib/utils';
import { PasswordInput } from './password-input';
import { Tooltip, type TooltipProps } from './tooltip';

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
  title,
  shortcut,
  tooltipSide,
  tooltipDelay,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    shortcut?: string;
    tooltipSide?: TooltipProps['side'];
    tooltipDelay?: number;
  }) {
  const Component = asChild ? Slot : 'button';
  const control = (
    <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
  return (
    <Tooltip content={title} shortcut={shortcut} side={tooltipSide} delay={tooltipDelay}>
      {props.disabled && title && !asChild ? (
        <span className="tooltip-disabled-trigger" tabIndex={0}>
          {control}
        </span>
      ) : (
        control
      )}
    </Tooltip>
  );
}

interface FieldContext {
  id: string;
  label: string;
  labelId: string;
  hintId?: string;
  setControlId(id: string): void;
}
const FieldLabelContext = React.createContext<FieldContext | undefined>(undefined);

function fieldAttributes(props: React.AriaAttributes & { id?: string }, field?: FieldContext) {
  return {
    id: props.id ?? field?.id,
    'aria-labelledby':
      props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined
        ? props['aria-labelledby']
        : field?.labelId,
    'aria-describedby':
      [props['aria-describedby'], field?.hintId].filter(Boolean).join(' ') || undefined,
  };
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => {
  const field = React.useContext(FieldLabelContext);
  const attributes = fieldAttributes(props, field);
  React.useLayoutEffect(() => {
    if (attributes.id) field?.setControlId(attributes.id);
  }, [attributes.id, field?.setControlId]);
  return props.type === 'password' ? (
    <PasswordInput
      ref={ref}
      className={className}
      {...props}
      {...attributes}
      revealLabel={field?.label}
    />
  ) : (
    <input ref={ref} className={cn('input', className)} {...props} {...attributes} />
  );
});
Input.displayName = 'Input';
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

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
  const id = React.useId();
  const [controlId, setControlId] = React.useState(id);
  const field = {
    id,
    label,
    labelId: `${id}-label`,
    hintId: hint ? `${id}-hint` : undefined,
    setControlId,
  };
  let labelledControl = controlId;
  const controls = React.Children.map(children, (child) => {
    if (
      !React.isValidElement<React.AriaAttributes & { id?: string }>(child) ||
      !['input', 'select', 'textarea'].includes(String(child.type))
    )
      return child;
    const attributes = fieldAttributes(child.props, field);
    labelledControl = attributes.id!;
    return React.cloneElement(child, attributes);
  });
  return (
    <FieldLabelContext.Provider value={field}>
      <div className="field">
        <label id={field.labelId} htmlFor={labelledControl} className="field-label">
          {label}
        </label>
        {controls}
        {hint && (
          <span id={field.hintId} className="field-hint">
            {hint}
          </span>
        )}
      </div>
    </FieldLabelContext.Provider>
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
