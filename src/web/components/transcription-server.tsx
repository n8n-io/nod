import { useId, useState } from 'react';
import { useModels } from '../hooks/use-models';
import { Check } from './icons';
import { Button, Dialog, DialogContent, DialogTitle, Field, Input, Notice } from './ui';

export function TranscriptionServer({
  disabled = false,
  onChanged,
}: {
  disabled?: boolean;
  onChanged(): void;
}) {
  const models = useModels();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const connection = models.data?.connections.find((item) => item.provider === 'compatible-speech');
  const busy = models.busy;
  function reset() {
    setUrl('');
    setKey('');
    setModel('');
    setEditing(false);
    models.setError('');
  }
  async function connect() {
    if (disabled || busy || !url.trim()) return;
    const saved = await models.change('/api/models/transcription', 'POST', {
      url: url.trim(),
      ...(key.trim() ? { key: key.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
    if (!saved) return;
    reset();
    onChanged();
  }
  async function disconnect() {
    if (disabled || busy || !connection) return;
    const removed = await models.change(`/api/models/connections/${connection.id}`, 'DELETE');
    if (!removed) return;
    reset();
    onChanged();
  }
  const form = editing || !connection;
  return (
    <>
      <div className="account-preference-row">
        <span id={`${id}-transcription`}>Transcription</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-describedby={`${id}-transcription`}
          disabled={disabled || !models.data}
          onClick={() => {
            models.setError('');
            setOpen(true);
          }}
        >
          {connection ? 'Manage' : 'Use your own server'}
        </Button>
      </div>
      {connection && (
        <p className="field-hint" data-analytics-private>
          {connection.status === 'reconnect'
            ? `Nod can’t reach ${connection.label}. Check that it is running, then connect again.`
            : `Voice messages go to ${connection.label}.`}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next || busy) return;
          reset();
          setOpen(false);
        }}
      >
        <DialogContent className="voice-connection-dialog" aria-describedby={`${id}-about`}>
          <DialogTitle>Transcription server</DialogTitle>
          <p className="field-hint" id={`${id}-about`}>
            Nod transcribes voice messages with this server only, instead of a voice service or the
            model on this device. It must accept OpenAI audio transcription requests, as a local
            Whisper server does.
          </p>
          {connection && !editing && connection.status === 'connected' && (
            <p className="voice-connection-status" role="status">
              <Check size={14} aria-hidden="true" />
              Connected. This server transcribes your voice messages.
            </p>
          )}
          {connection && !editing && (
            <div className="voice-connect-manage">
              <div className="voice-connection-entry">
                <span className="voice-connection-identity" data-analytics-private>
                  <span>{connection.label}</span>
                  <small>
                    {connection.status === 'reconnect'
                      ? 'Reconnect to continue'
                      : connection.managed
                        ? 'Set up on this device'
                        : connection.keyEnding
                          ? `Key …${connection.keyEnding}`
                          : 'Connected without a key'}
                  </small>
                </span>
                {!connection.managed && (
                  <div className="voice-connect-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled || busy}
                      onClick={() => {
                        models.setError('');
                        setEditing(true);
                      }}
                    >
                      Change
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled || busy}
                      onClick={() => void disconnect()}
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {form && (
            <form
              className="voice-connect-form"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <Field label="Server address">
                <Input
                  inputMode="url"
                  data-analytics-private
                  value={url}
                  required
                  maxLength={2000}
                  placeholder="http://localhost:8000/v1"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={disabled || busy}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
              <Field label="API key (optional)">
                <Input
                  type="password"
                  data-analytics-private
                  value={key}
                  maxLength={32000}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled || busy}
                  onChange={(event) => setKey(event.target.value)}
                />
              </Field>
              <Field label="Model (optional)">
                <Input
                  data-analytics-private
                  value={model}
                  maxLength={200}
                  placeholder="whisper-1"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled || busy}
                  onChange={(event) => setModel(event.target.value)}
                />
              </Field>
              <div className="voice-connect-actions">
                <Button type="submit" size="sm" disabled={disabled || busy || !url.trim()}>
                  {busy ? 'Connecting…' : 'Connect'}
                </Button>
                {connection && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || busy}
                    onClick={reset}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          )}
          {models.error && <Notice>{models.error}</Notice>}
        </DialogContent>
      </Dialog>
    </>
  );
}
