import { useEffect, useRef, useState } from 'react';
import { api, apiResponse, errorMessage } from '../lib/api';
import { ownedArtifactUrl } from '../lib/attachment-url';
import type { Artifact } from '../../shared/contracts';
import type { ImagePreview } from './attachment-images';
import { Button, Notice } from './ui';
import { reuseFile } from './file-actions';

export function ArtifactEdit({ item, onClose }: { item: ImagePreview; onClose(): void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    void load();
  }, [item.id]);
  useEffect(() => {
    if (error && !busy) editor.current?.focus({ preventScroll: true });
  }, [error, busy]);
  async function load() {
    setBusy(true);
    setError('');
    try {
      if (!ownedArtifactUrl(item.url) || item.size > 4000000)
        throw new Error('This file is too large to edit here.');
      const response = await apiResponse(item.url);
      if (!response.ok) throw new Error('The file could not be loaded.');
      setText(await response.text());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (text === null || busy) return;
    setBusy(true);
    setError('');
    try {
      const name = item.name.replace(/(\.[^.]+)?$/, ' (edited)$1');
      const body = new FormData();
      body.append('file', new File([text], name, { type: item.mimeType ?? 'text/plain' }));
      const artifact = await api<Artifact>('/api/uploads', { method: 'POST', body });
      reuseFile(artifact);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="artifact-edit"
      aria-label={`Edit a copy of ${item.name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!busy || text === null) onClose();
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <p>Edit a copy. The original stays in the conversation.</p>
      {text === null ? (
        <Button onClick={() => void load()} disabled={busy}>
          {busy ? 'Loading…' : 'Try again'}
        </Button>
      ) : (
        <textarea
          ref={editor}
          autoFocus
          disabled={busy}
          className="input"
          aria-label="File text"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {error && <Notice>{error}</Notice>}
      <div>
        <Button onClick={() => void save()} disabled={busy || text === null}>
          {busy ? (text === null ? 'Loading…' : 'Saving…') : 'Save copy to message'}
        </Button>
        <Button variant="ghost" disabled={busy && text !== null} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
