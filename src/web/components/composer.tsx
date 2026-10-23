import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { ArrowUp, Paperclip, X, RotateCcw, CornerUpLeft, Square } from './icons';
import type { Artifact, Message } from '../../shared/contracts';
import { fileBytes } from '../../shared/files';
import { api, errorMessage } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';
import { createComposerExtensions } from '../lib/composer-editor';
import { composerMarkdown, parseComposerMarkdown } from '../lib/composer-markdown';
import { EditorFormatting } from './editor-formatting';
import { Button, Notice } from './ui';
import { ownedArtifactUrl, type ImagePreview } from './attachment-images';
import { FileGlyph } from './attachment-glyph';
import { attachmentKind, fileSize, localPreviewable } from '../lib/attachment-kind';
import { useArtifactDrawer } from './artifact-context';

interface DraftAttachment {
  id: string;
  file: File;
  state: 'queued' | 'uploading' | 'failed' | 'ready';
  error?: string;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
  artifact?: Artifact;
  controller?: AbortController;
}

export interface ComposerHandle {
  focus(): void;
}

export type ComposerSendResult = { sent: true } | { sent: false; restoreText: boolean };

interface ComposerProps {
  ready: boolean;
  text: string;
  setText(value: string): void;
  replyTo: Pick<Message, 'id' | 'role' | 'text'> | null;
  clearReply(): void;
  onSend(text: string, attachments: Artifact[]): Promise<ComposerSendResult>;
  onStop?(): void;
  stopping?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { ready, text, setText, replyTo, clearReply, onSend, onStop, stopping = false },
  ref,
) {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const drawer = useArtifactDrawer();
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const attachmentValues = useRef<DraftAttachment[]>([]);
  const uploads = useRef(new Set<AbortController>());
  const uploadQueue = useRef(Promise.resolve());
  const previewUrls = useRef(new Set<string>());
  const lastText = useRef(text);
  const sends = useRef(0);
  const pendingSends = useRef(0);
  const unsent = useRef<Array<{ sequence: number; text: string; attachments: DraftAttachment[] }>>(
    [],
  );
  const actions = useRef({
    submit: () => {},
    upload: (_files: File[], _method: 'paste') => {},
  });
  const extensions = useMemo(
    () =>
      createComposerExtensions({
        submit: () => actions.current.submit(),
        upload: (files) => actions.current.upload(files, 'paste'),
      }),
    [],
  );
  const editor = useEditor({
    extensions,
    content: parseComposerMarkdown(text),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Message nod',
        'aria-multiline': 'true',
        'aria-describedby': 'composer-keyboard-hint',
        class: 'composer-editor message-text',
      },
    },
    onUpdate: ({ editor: current }) => {
      const value = composerMarkdown(current.state.doc);
      lastText.current = value;
      setText(value);
    },
  });
  function focus() {
    if (editor && !editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: false });
  }
  function restoreFocus() {
    if (document.activeElement === document.body || form.current?.contains(document.activeElement))
      focus();
  }
  useImperativeHandle(ref, () => ({ focus }), [editor]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of uploads.current) controller.abort();
      uploads.current.clear();
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    };
  }, []);
  useEffect(() => {
    if (editor && text !== lastText.current) {
      lastText.current = text;
      editor.commands.setContent(parseComposerMarkdown(text), { emitUpdate: false });
    }
  }, [editor, text]);
  function updateAttachments(values: DraftAttachment[]) {
    attachmentValues.current = values;
    setAttachments(values);
  }
  function releasePreview(item: DraftAttachment) {
    if (item.previewUrl && previewUrls.current.delete(item.previewUrl))
      URL.revokeObjectURL(item.previewUrl);
  }
  function removeAttachment(item: DraftAttachment) {
    item.controller?.abort();
    if (item.controller) uploads.current.delete(item.controller);
    releasePreview(item);
    updateAttachments(attachmentValues.current.filter((value) => value.id !== item.id));
  }
  async function queueUploads(items: DraftAttachment[]) {
    const send = async () => {
      for (const item of items) {
        const controller = item.controller!;
        if (!mounted.current || controller.signal.aborted) continue;
        updateAttachments(
          attachmentValues.current.map((value) =>
            value.id === item.id ? { ...value, state: 'uploading' } : value,
          ),
        );
        try {
          const body = new FormData();
          body.append('file', item.file);
          const artifact = await api<Artifact>('/api/uploads', {
            method: 'POST',
            body,
            signal: controller.signal,
          });
          if (mounted.current && !controller.signal.aborted)
            updateAttachments(
              attachmentValues.current.map((value) =>
                value.id === item.id
                  ? { ...value, artifact, state: 'ready', controller: undefined }
                  : value,
              ),
            );
        } catch (cause) {
          if (mounted.current && !controller.signal.aborted)
            updateAttachments(
              attachmentValues.current.map((value) =>
                value.id === item.id
                  ? {
                      ...value,
                      state: 'failed',
                      error: errorMessage(cause),
                      controller: undefined,
                    }
                  : value,
              ),
            );
        } finally {
          uploads.current.delete(controller);
        }
      }
    };
    const queued = uploadQueue.current.then(send);
    uploadQueue.current = queued;
    await queued;
    if (mounted.current) restoreFocus();
  }
  function retryAttachment(item: DraftAttachment) {
    if (attachmentValues.current.find((value) => value.id === item.id)?.state !== 'failed') return;
    const controller = new AbortController();
    uploads.current.add(controller);
    const queued: DraftAttachment = { ...item, state: 'queued', error: undefined, controller };
    updateAttachments(
      attachmentValues.current.map((value) => (value.id === item.id ? queued : value)),
    );
    void queueUploads([queued]);
  }
  function upload(files: File[], method: 'picker' | 'drop' | 'paste') {
    if (!files.length) return;
    if (fileInput.current) fileInput.current.value = '';
    if (files.some((file) => file.size > fileBytes)) {
      setError(`Each file must be ${fileBytes / 1024 / 1024} MB or smaller.`);
      return;
    }
    const first = files[0];
    captureAnalytics('nod_attachment_added', {
      method,
      kind: first.type.startsWith('image/')
        ? 'image'
        : first.type === 'application/pdf' || /\.pdf$/i.test(first.name)
          ? 'pdf'
          : 'other',
      count: files.length === 1 ? '1' : files.length <= 5 ? '2-5' : '6+',
    });
    const items: DraftAttachment[] = files.map((file) => {
      const controller = new AbortController();
      uploads.current.add(controller);
      let previewUrl: string | undefined;
      if (localPreviewable(file.type, file.name)) {
        try {
          previewUrl = URL.createObjectURL(file);
          previewUrls.current.add(previewUrl);
        } catch {}
      }
      return {
        id: crypto.randomUUID(),
        file,
        state: 'queued',
        name: file.name,
        mimeType: file.type,
        size: file.size,
        controller,
        previewUrl,
      };
    });
    updateAttachments([...attachmentValues.current, ...items]);
    setError('');
    void queueUploads(items);
  }
  function restoreUnsent() {
    const items = unsent.current.splice(0).sort((a, b) => a.sequence - b.sequence);
    if (!items.length || !editor || editor.isDestroyed || !mounted.current) return;
    editor.commands.setContent(
      parseComposerMarkdown(
        [...items.map((item) => item.text), composerMarkdown(editor.state.doc)]
          .filter(Boolean)
          .join('\n\n'),
      ),
    );
    updateAttachments([...items.flatMap((item) => item.attachments), ...attachmentValues.current]);
    restoreFocus();
  }
  async function submit() {
    if (!editor || !ready || attachmentValues.current.some((item) => !item.artifact)) return;
    const sentText = composerMarkdown(editor.state.doc).trim();
    const sentAttachments = attachmentValues.current;
    if (!sentText && !sentAttachments.length) return;
    const sequence = ++sends.current;
    pendingSends.current++;
    setError('');
    editor.commands.clearContent();
    updateAttachments([]);
    focus();
    let result: ComposerSendResult = { sent: false, restoreText: true };
    try {
      result = await onSend(
        sentText,
        sentAttachments.map((item) => item.artifact!),
      );
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pendingSends.current--;
      if (result.sent || !result.restoreText)
        for (const item of sentAttachments) releasePreview(item);
      else {
        unsent.current.push({ sequence, text: sentText, attachments: sentAttachments });
        setTimeout(restoreUnsent);
      }
      if (mounted.current && !editor.isDestroyed) restoreFocus();
    }
  }
  actions.current = {
    submit: () => void submit(),
    upload: (files, method) => void upload(files, method),
  };
  const pendingUploads = attachments.filter((item) => !item.artifact).length;
  const images = useMemo(
    () =>
      attachments.flatMap((item): ImagePreview[] => {
        const url =
          item.previewUrl ||
          (item.artifact && ownedArtifactUrl(item.artifact.url) ? item.artifact.url : undefined);
        return attachmentKind(item.mimeType, item.name) && url
          ? [
              {
                id: item.id,
                name: item.name,
                size: item.size,
                mimeType: item.mimeType,
                url,
                downloadUrl: item.artifact?.url,
              },
            ]
          : [];
      }),
    [attachments],
  );
  const { setDrafts } = drawer;
  useEffect(() => {
    setDrafts(images);
    return () => setDrafts([]);
  }, [images, setDrafts]);
  return (
    <div className="composer-wrap">
      {error && <Notice>{error}</Notice>}
      {replyTo && (
        <div className="reply-context composer-reply">
          <CornerUpLeft size={16} />
          <div>
            <strong>Replying to {replyTo.role === 'assistant' ? 'nod' : 'yourself'}</strong>
            <span>{replyTo.text || 'Attachment'}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={clearReply}
            aria-label="Cancel reply"
          >
            <X size={16} />
          </Button>
        </div>
      )}
      <form
        ref={form}
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDropCapture={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          void upload(Array.from(event.dataTransfer.files), 'drop');
        }}
      >
        {attachments.length > 0 && (
          <div
            className="pending-attachments composer-attachments"
            aria-label="Message attachments"
          >
            {attachments.map((item) => {
              const preview = images.some((image) => image.id === item.id);
              const uploading = item.state === 'uploading' || item.state === 'queued';
              const status =
                item.state === 'uploading'
                  ? 'Uploading…'
                  : item.state === 'queued'
                    ? 'Waiting…'
                    : item.state === 'failed'
                      ? 'Upload failed'
                      : item.size < 1024
                        ? `${item.size} B`
                        : fileSize(item.size);
              return (
                <div
                  className={`composer-file${item.state === 'failed' ? ' is-failed' : ''}`}
                  key={item.id}
                >
                  <button
                    type="button"
                    className="composer-file-open"
                    disabled={!preview}
                    aria-label={preview ? `Open ${item.name}` : item.name}
                    aria-current={drawer.selectedId === item.id || undefined}
                    aria-describedby={`attachment-status-${item.id}`}
                    title={`${item.name} · ${item.size.toLocaleString()} bytes`}
                    onClick={(event) =>
                      drawer.open(
                        item.id,
                        { element: event.currentTarget, keyboard: event.detail === 0 },
                        'drafts',
                      )
                    }
                  >
                    <FileGlyph name={item.name} mimeType={item.mimeType} />
                    <span className="composer-file-name">{item.name}</span>
                    <span
                      className="composer-file-status"
                      id={`attachment-status-${item.id}`}
                      role="status"
                      title={item.error}
                    >
                      {status}
                      {item.error && <span className="sr-only">: {item.error}</span>}
                    </span>
                  </button>
                  {item.state === 'failed' && (
                    <button
                      type="button"
                      className="composer-file-retry"
                      onClick={() => retryAttachment(item)}
                      aria-label={`Retry uploading ${item.name}`}
                      title={item.error}
                    >
                      <RotateCcw size={12} />
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="composer-file-remove"
                    onClick={() => removeAttachment(item)}
                    aria-label={`Remove ${item.name}`}
                  >
                    <X size={14} />
                  </button>
                  {uploading && (
                    <span
                      className={`composer-file-progress${item.state === 'queued' ? ' is-queued' : ''}`}
                      role="progressbar"
                      aria-label={`${item.state === 'queued' ? 'Waiting to upload' : 'Uploading'} ${item.name}`}
                    >
                      <span />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <EditorContent editor={editor} />
        <EditorFormatting editor={editor} />
        <span className="sr-only" id="composer-keyboard-hint">
          Enter to send. Shift or Alt plus Enter for a new line or list item.
        </span>
        <div className="composer-tools">
          <div className="composer-left">
            <input
              ref={fileInput}
              type="file"
              tabIndex={-1}
              multiple
              className="sr-only"
              aria-label="Choose files"
              onChange={(event) => void upload(Array.from(event.target.files ?? []), 'picker')}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach files"
              title="Attach files or paste an image"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={16} />
            </Button>
          </div>
          <div className="composer-right">
            {onStop && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="stop-button"
                aria-label="Stop nod"
                title="Stop"
                disabled={stopping}
                onClick={onStop}
              >
                <Square size={16} fill="currentColor" />
              </Button>
            )}
            <Button
              type="submit"
              size="icon"
              className="send-button"
              aria-label="Send message"
              disabled={!ready || pendingUploads > 0 || (!text.trim() && !attachments.length)}
            >
              <ArrowUp size={18} />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
});
