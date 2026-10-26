import { useState, type FormEvent } from 'react';
import { apiResponse } from '../lib/api';
import { NodGlyph } from './motion';
import { Button, Field, Input, Notice } from './ui';

export function ServerAccess({ onConnected }: { onConnected(): Promise<boolean> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiResponse('/api/access', {
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ key: key.trim() }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? 'Check your token and try again.'
            : 'Could not connect. Try again.',
        );
        return;
      }
      if (!(await onConnected())) throw new Error('The server session could not be opened.');
      setKey('');
    } catch {
      setError('Could not connect. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="server-access-page">
      <form
        className="server-access"
        aria-labelledby="server-access-title"
        onSubmit={(event) => void connect(event)}
      >
        <header className="server-access-header">
          <NodGlyph size={72} mode="still" />
          <h1 id="server-access-title">Connect to Nod</h1>
          <p>Enter your server’s token to open your assistant.</p>
        </header>
        <Field label="Authentication token">
          <Input
            type="password"
            autoComplete="current-password"
            name="token"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            required
            disabled={busy}
          />
        </Field>
        {error && <Notice>{error}</Notice>}
        <Button type="submit" disabled={busy || !key.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <p className="server-access-note">
          Your chats, files and connected apps stay on this server.
        </p>
      </form>
    </main>
  );
}
