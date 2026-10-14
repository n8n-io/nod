import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Notice,
} from './ui';
import { loopbackHost } from '../../shared/loopback';

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
  const [error, setError] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setUrl('');
          setLabel('');
          setError('');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="vault-dialog">
        <DialogTitle>Sign in to a website</DialogTitle>
        <DialogDescription>
          Otto opens the website’s home page in its private browser. Sign in once and later tasks
          reuse the session.
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            let address: URL;
            try {
              address = new URL(url);
              if (
                url.length > 2048 ||
                address.username ||
                address.password ||
                !['https:', 'http:'].includes(address.protocol) ||
                (address.protocol === 'http:' && !loopbackHost(address.hostname))
              )
                throw new Error();
            } catch {
              setError('Use a secure website address without a username or password.');
              return;
            }
            onAsk(
              `Connect to ${address.origin} in your private browser${label.trim() ? ` as ${label.trim()}` : ''}. Help me sign in through the secure form if needed, then save the browser session.`,
            );
            onOpenChange(false);
            setUrl('');
            setLabel('');
            setError('');
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
              maxLength={2048}
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
          {error && <Notice>{error}</Notice>}
          <Button type="submit">Continue in chat</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
