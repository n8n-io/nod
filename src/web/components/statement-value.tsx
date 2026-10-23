import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';

export function StatementValue({
  text,
  label,
  children,
}: {
  text: ReactNode;
  label: string;
  children(close: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="statement-value">{text}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="statement-pop" align="start" sideOffset={8} aria-label={label}>
          {children(() => setOpen(false))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
