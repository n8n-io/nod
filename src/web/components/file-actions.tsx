import { useEffect, useRef, useState } from 'react';
import { Copy, Download, List, Plus } from './icons';
import type { Artifact } from '../../shared/contracts';
import type { ImagePreview } from './attachment-images';
import { ownedArtifactUrl } from '../lib/attachment-url';
import { copyImage, selectedText } from '../lib/clipboard';
import { desktopFileAction, desktopFilesAvailable, nativeFileMenu } from '../lib/desktop';
import { errorMessage } from '../lib/api';
import { Button } from './ui';

export function reuseFile(item: ImagePreview) {
  if (!ownedArtifactUrl(item.url)) return;
  window.dispatchEvent(new CustomEvent('nod:attach-artifact', { detail: item }));
}

export function fileDrag(event: React.DragEvent, item: ImagePreview) {
  if (!ownedArtifactUrl(item.url)) return;
  event.dataTransfer.setData('application/x-nod-artifact', JSON.stringify(item));
  event.dataTransfer.setData('text/uri-list', new URL(item.url, location.origin).href);
  event.dataTransfer.effectAllowed = 'copy';
  if (desktopFilesAvailable()) {
    event.preventDefault();
    void desktopFileAction(item.id, 'drag').catch((cause) =>
      window.dispatchEvent(new CustomEvent('nod:file-notice', { detail: errorMessage(cause) })),
    );
  }
}

export function FileActions({ item }: { item: ImagePreview }) {
  const actions = useRef<HTMLSpanElement>(null);
  const activeId = useRef(item.id);
  activeId.current = item.id;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNotice('');
    setBusy(false);
  }, [item.id]);
  const image = /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(item.mimeType ?? '');
  useEffect(() => {
    const target =
      actions.current?.closest<HTMLElement>('.attachment-card,.attachment-image-item') ??
      actions.current;
    if (!target || !desktopFilesAvailable()) return;
    const open = (event: MouseEvent) => {
      if (selectedText(target)) return;
      event.preventDefault();
      event.stopPropagation();
      void menu();
    };
    target.addEventListener('contextmenu', open);
    return () => target.removeEventListener('contextmenu', open);
  }, [item.id, item.url, image]);
  useEffect(() => {
    if (!notice || notice === 'Saved to Downloads') return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!ownedArtifactUrl(item.url)) return null;
  async function run(action: string) {
    if (action === 'reuse') {
      reuseFile(item);
      return;
    }
    const id = item.id;
    setBusy(true);
    try {
      if (action === 'copy') {
        await copyImage(item.url);
        if (activeId.current === id) setNotice('Image copied');
      } else {
        await desktopFileAction(item.id, action as 'save' | 'open' | 'show' | 'prepare');
        if (activeId.current === id) setNotice(action === 'save' ? 'Saved to Downloads' : '');
      }
    } catch (cause) {
      if (activeId.current === id) setNotice(errorMessage(cause));
    } finally {
      if (activeId.current === id) setBusy(false);
    }
  }
  async function menu() {
    try {
      const action = await nativeFileMenu(item.id, image);
      if (action) await run(action);
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }
  return (
    <span className="file-actions" ref={actions}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Use ${item.name} in message`}
        title="Use in message"
        onClick={() => reuseFile(item)}
      >
        <Plus size={15} />
      </Button>
      {image && (
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={`Copy image ${item.name}`}
          title="Copy image"
          onClick={() => void run('copy')}
        >
          <Copy size={15} />
        </Button>
      )}
      {desktopFilesAvailable() ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={`Save ${item.name}`}
            title="Save to Downloads"
            onClick={() => void run('save')}
          >
            <Download size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={`File actions for ${item.name}`}
            title="File actions"
            onClick={() => void menu()}
          >
            <List size={15} />
          </Button>
        </>
      ) : (
        <a
          href={item.url}
          download={item.name}
          aria-label={`Download ${item.name}`}
          title="Download"
        >
          <Download size={15} />
        </a>
      )}
      {notice && (
        <span role="status" className="file-action-notice">
          {notice}
          {notice === 'Saved to Downloads' && (
            <>
              <button type="button" onClick={() => void run('open')}>
                Open
              </button>
              <button type="button" onClick={() => void run('show')}>
                Show in folder
              </button>
            </>
          )}
        </span>
      )}
    </span>
  );
}

export function artifactFromPreview(item: ImagePreview): Artifact {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType ?? 'application/octet-stream',
    size: item.size,
    url: item.url,
  };
}
