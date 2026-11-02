import { Tooltip } from './tooltip';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Notice } from './ui';
import { errorMessage } from '../lib/api';

export function InlineName({
  value,
  label,
  save,
}: {
  value: string;
  label: string;
  save(value: string): Promise<void>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!editing && wasEditing.current) trigger.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => {
    if (error && !busy) field.current?.focus({ preventScroll: true });
  }, [error, busy]);
  if (!editing)
    return (
      <Tooltip content={`Edit ${label}`}>
        <button
          ref={trigger}
          type="button"
          className="inline-name"
          aria-label={`Edit ${label}: ${value}`}
          onClick={() => {
            setDraft(value);
            setError('');
            setEditing(true);
          }}
        >
          {value}
        </button>
      </Tooltip>
    );
  return (
    <form
      className="inline-name-form"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !draft.trim()) return;
        setBusy(true);
        void save(draft.trim())
          .then(() => setEditing(false))
          .catch((cause) => setError(errorMessage(cause)))
          .finally(() => setBusy(false));
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          setEditing(false);
        }
      }}
    >
      <Input
        ref={field}
        autoFocus
        value={draft}
        maxLength={160}
        aria-label={label}
        disabled={busy}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <Button
        size="sm"
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
      {error && <Notice>{error}</Notice>}
    </form>
  );
}
