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

export function ArtifactExport({ files }: { files: ImagePreview[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      const items = files.filter(
        (file) => selected.includes(file.id) && ownedArtifactUrl(file.url),
      );
      if (!items.length || items.reduce((sum, file) => sum + file.size, 0) > 90 * 1024 * 1024)
        throw new Error('Choose files with a total size of 90 MB or less.');
      const entries: Record<string, Uint8Array> = Object.create(null);
      const names = new Set<string>();
      let total = 0;
      for (const item of items) {
        const response = await apiResponse(item.url);
        if (!response.ok) throw new Error(`${item.name} could not be loaded.`);
        let name = item.name.replace(/[\\/\x00-\x1f\x7f]/g, '_');
        if (!name || name === '.' || name === '..') name = 'file';
        const original = name;
        for (let suffix = 2; names.has(name.normalize('NFC').toLowerCase()); suffix++)
          name = original.replace(/(\.[^.]+)?$/, ` (${suffix})$1`);
        names.add(name.normalize('NFC').toLowerCase());
        const bytes = new Uint8Array(await response.arrayBuffer());
        total += bytes.byteLength;
        if (total > 90 * 1024 * 1024)
          throw new Error('Choose files with a total size of 90 MB or less.');
        entries[name] = bytes;
      }
      const { zipSync } = await import('fflate');
      const archive = zipSync(entries, { level: 0 });
      const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'nod-files.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="artifact-export"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary>Export files</summary>
      <div>
        {files
          .filter((file) => ownedArtifactUrl(file.url))
          .map((file) => (
            <label key={file.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.includes(file.id)}
                onChange={(event) =>
                  setSelected((values) =>
                    event.target.checked
                      ? [...values, file.id]
                      : values.filter((id) => id !== file.id),
                  )
                }
              />
              {file.name}
            </label>
          ))}
        <Button size="sm" disabled={busy || !selected.length} onClick={() => void save()}>
          {busy ? 'Preparing…' : `Download ZIP (${selected.length})`}
        </Button>
        {error && <Notice>{error}</Notice>}
      </div>
    </details>
  );
}
