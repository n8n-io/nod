import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, List, Plus } from './icons';
import type { Artifact } from '../../shared/contracts';
import type { ImagePreview } from './attachment-images';
import { ownedArtifactUrl } from '../lib/attachment-url';
import { copyImage, selectedText } from '../lib/clipboard';
import { desktopFileAction, desktopFilesAvailable, nativeFileMenu } from '../lib/desktop';
import { errorMessage } from '../lib/api';
import { Button } from './ui';

export function reuseFile(item: ImagePreview) {
  const artifact = artifactFromPreview(item);
  if (!ownedArtifactUrl(artifact.url)) return;
  window.dispatchEvent(new CustomEvent('nod:attach-artifact', { detail: artifact }));
}

export function fileDrag(event: React.DragEvent, item: ImagePreview) {
  const artifact = artifactFromPreview(item);
  if (!ownedArtifactUrl(artifact.url)) return;
  event.dataTransfer.setData('application/x-nod-artifact', JSON.stringify(artifact));
  event.dataTransfer.setData('text/uri-list', new URL(artifact.url, location.origin).href);
  event.dataTransfer.effectAllowed = 'copy';
  if (desktopFilesAvailable()) {
    event.preventDefault();
    void desktopFileAction(artifact.id, 'drag').catch((cause) =>
      window.dispatchEvent(new CustomEvent('nod:file-notice', { detail: errorMessage(cause) })),
    );
  }
}

export function prepareFile(item: ImagePreview) {
  const artifact = artifactFromPreview(item);
  if (desktopFilesAvailable() && ownedArtifactUrl(artifact.url))
    void desktopFileAction(artifact.id, 'prepare').catch(() => {});
}

export function FileActions({ item }: { item: ImagePreview }) {
  const artifact = artifactFromPreview(item);
  const actions = useRef<HTMLSpanElement>(null);
  const activeId = useRef(item.id);
  activeId.current = item.id;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const tooltipElement = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState<{
    label: string;
    x: number;
    y: number;
    below: number;
  } | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function hideTooltip() {
    clearTimeout(tooltipTimer.current);
    setTooltip(null);
  }
  function showTooltip(target: EventTarget, delay: number) {
    hideTooltip();
    const control =
      target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
    if (!control) return;
    tooltipTimer.current = setTimeout(() => {
      const box = control.getBoundingClientRect();
      setTooltip({
        label: control.dataset.tooltip!,
        x: box.left + box.width / 2,
        y: box.top - 8,
        below: box.bottom + 8,
      });
    }, delay);
  }
  useLayoutEffect(() => {
    const element = tooltipElement.current;
    if (!tooltip || !element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, tooltip.x - width / 2))}px`;
    const above = tooltip.y - height;
    element.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, above >= 8 ? above : tooltip.below))}px`;
  }, [tooltip]);
  useEffect(() => {
    const hide = () => hideTooltip();
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(tooltipTimer.current);
      window.removeEventListener('resize', hide);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);
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
  }, [item.id, item.url, item.downloadUrl, image]);
  useEffect(() => {
    if (!notice || notice === 'Saved to Downloads') return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!ownedArtifactUrl(artifact.url)) return null;
  async function run(action: string) {
    if (action === 'reuse') {
      reuseFile(item);
      return;
    }
    const id = item.id;
    if (activeId.current === id) setBusy(true);
    try {
      if (action === 'copy') {
        await copyImage(artifact.url);
        if (activeId.current === id) setNotice('Image copied');
      } else {
        await desktopFileAction(artifact.id, action as 'save' | 'open' | 'show' | 'prepare');
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
      const action = await nativeFileMenu(artifact.id, image);
      if (action) await run(action);
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }
  return (
    <span
      className="file-actions"
      ref={actions}
      onPointerOver={(event) => {
        if (event.pointerType === 'mouse') showTooltip(event.target, 550);
      }}
      onPointerOut={hideTooltip}
      onFocus={(event) => showTooltip(event.target, 0)}
      onBlur={hideTooltip}
      onClick={hideTooltip}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hideTooltip();
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Use ${item.name} in message`}
        data-tooltip="Add to message"
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
          data-tooltip="Copy image"
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
            data-tooltip="Save to Downloads"
            onClick={() => void run('save')}
          >
            <Download size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={`File actions for ${item.name}`}
            data-tooltip="More file actions"
            onClick={() => void menu()}
          >
            <List size={15} />
          </Button>
        </>
      ) : (
        <a
          href={artifact.url}
          download={item.name}
          aria-label={`Download ${item.name}`}
          data-tooltip="Download file"
        >
          <Download size={15} />
        </a>
      )}
      {notice && (
        <span role="status" className="file-action-notice">
          {notice}
          {notice === 'Saved to Downloads' && (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => void run('open')}>
                Open
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void run('show')}>
                Show in folder
              </Button>
            </>
          )}
        </span>
      )}
      {tooltip &&
        createPortal(
          <span
            ref={tooltipElement}
            role="tooltip"
            className="file-action-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            {tooltip.label}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function artifactFromPreview(item: ImagePreview): Artifact {
  const url = item.downloadUrl && ownedArtifactUrl(item.downloadUrl) ? item.downloadUrl : item.url;
  return {
    id: ownedArtifactUrl(url) ? url.slice('/api/artifacts/'.length) : item.id,
    name: item.name,
    mimeType: item.mimeType ?? 'application/octet-stream',
    size: item.size,
    url,
  };
}
