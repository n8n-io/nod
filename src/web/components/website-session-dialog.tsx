import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, Input } from './ui';

export function WebsiteSessionDialog({
  open,
  onOpenChange,
  onAsk,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAsk(text: string): void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="vault-dialog">
        <DialogTitle>Sign in to a website</DialogTitle>
        <DialogDescription>
          Otto opens the site in its private browser. Sign in once and later tasks reuse the
          session.
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAsk(
              `Connect to ${url} in your private browser${label.trim() ? ` as ${label.trim()}` : ''}. Help me sign in through the secure form if needed, then save the browser session.`,
            );
            onOpenChange(false);
            setUrl('');
            setLabel('');
          }}
        >
          <Field label="Website address">
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/account"
              autoFocus
              required
            />
          </Field>
          <Field label="Account name">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Optional"
              maxLength={100}
            />
          </Field>
          <Button type="submit">Continue in chat</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
