import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link2 } from './icons';
import { api, errorMessage } from '../lib/api';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Notice,
} from './ui';

export function ManualMcpDialog({
  onClose,
  onCreated,
  returnFocus,
}: {
  onClose(): void;
  onCreated(id: string): void;
  returnFocus(): HTMLElement | null;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [auth, setAuth] = useState('oauth');
  const [clientIdRequired, setClientIdRequired] = useState(false);
  const request = useRef<AbortController | null>(null);
  const continuing = useRef(false);
  useEffect(() => () => request.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const values = new FormData(event.currentTarget);
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ id: string }>('/api/apps/mcp', {
        method: 'POST',
        body: JSON.stringify({
          ...Object.fromEntries(values),
          ...(auth === 'oauth' && clientIdRequired ? { clientIdRequired: true } : {}),
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      continuing.current = true;
      onCreated(result.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="app-discovery-dialog"
        aria-busy={saving}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!continuing.current) returnFocus()?.focus({ preventScroll: true });
        }}
      >
        <div className="app-discovery-heading">
          <span className="app-discovery-logo">
            <Link2 size={24} aria-hidden="true" />
          </span>
          <div>
            <DialogTitle>Connect an MCP server</DialogTitle>
            <DialogDescription>Add a server to use its tools in Nod.</DialogDescription>
          </div>
        </div>
        <form onSubmit={(event) => void submit(event)} autoComplete="off">
          <Field label="Name">
            <Input
              name="name"
              placeholder="My workspace"
              required
              minLength={2}
              maxLength={80}
              pattern="[A-Za-z0-9][A-Za-z0-9 .&amp;'_\-]{1,79}"
              disabled={saving}
            />
          </Field>
          <Field label="Server URL">
            <Input
              name="endpoint"
              type="url"
              placeholder="https://example.com/mcp"
              pattern="[Hh][Tt][Tt][Pp][Ss]://.*"
              required
              maxLength={2048}
              spellCheck={false}
              disabled={saving}
            />
          </Field>
          <Field label="Authentication">
            <select
              className="input"
              name="auth"
              value={auth}
              onChange={(event) => setAuth(event.target.value)}
              disabled={saving}
            >
              <option value="oauth">Sign in through your browser</option>
              <option value="bearer">Access token</option>
              <option value="x-api-key">API key</option>
            </select>
          </Field>
          {auth === 'oauth' && (
            <label className="app-discovery-client">
              <Checkbox
                checked={clientIdRequired}
                onChange={(event) => setClientIdRequired(event.target.checked)}
                disabled={saving}
              />
              <span>This server requires a client ID</span>
            </label>
          )}
          {error && <Notice>{error}</Notice>}
          <Button type="submit" disabled={saving}>
            {saving ? 'Checking server…' : 'Continue'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
