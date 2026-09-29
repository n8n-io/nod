import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { ArrowUp, Paperclip, X, FileText, LoaderCircle, CornerUpLeft } from 'lucide-react';
import type { Artifact, Message } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { createComposerExtensions } from '../lib/composer-editor';
import { Button, Notice } from './ui';
import {
  ImageViewer,
  AttachmentThumbnail,
  attachmentKind,
  localPreviewable,
  ownedArtifactUrl,
  previewableImage,
  type ImagePreview,
} from './attachment-images';

interface DraftAttachment {
  id: string;
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
  sending: boolean;
  text: string;
  setText(value: string): void;
  replyTo: Pick<Message, 'id' | 'role' | 'text'> | null;
  clearReply(): void;
  onSend(text: string, attachments: Artifact[]): Promise<ComposerSendResult>;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { ready, sending, text, setText, replyTo, clearReply, onSend },
  ref,
) {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const attachmentValues = useRef<DraftAttachment[]>([]);
  const uploads = useRef(new Set<AbortController>());
  const previewUrls = useRef(new Set<string>());
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const sendLock = useRef(false);
  const lastText = useRef(text);
  const actions = useRef({ submit: () => {}, upload: (_files: File[]) => {} });
  const extensions = useMemo(
    () =>
      createComposerExtensions({
        submit: () => actions.current.submit(),
        upload: (files) => actions.current.upload(files),
      }),
    [],
  );
  const editor = useEditor({
    extensions,
    content: text,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Message Otto',
        'aria-multiline': 'true',
        'aria-describedby': 'composer-keyboard-hint',
        class: 'composer-editor message-text',
      },
    },
    onUpdate: ({ editor: current }) => {
      const value = current.getMarkdown();
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
      editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: false });
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
  async function upload(files: File[]) {
    if (!files.length) return;
    if (files.length + attachmentValues.current.length > 5) {
      setError('Attach up to five files per message.');
      return;
    }
    if (files.some((file) => file.size > 15 * 1024 * 1024)) {
      setError('Each file must be 15 MB or smaller.');
      return;
    }
    const items: DraftAttachment[] = files.map((file) => {
      const controller = new AbortController();
      uploads.current.add(controller);
      let previewUrl: string | undefined;
      if (localPreviewable(file.type)) {
        try {
          previewUrl = URL.createObjectURL(file);
          previewUrls.current.add(previewUrl);
        } catch {}
      }
      return {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        controller,
        previewUrl,
      };
    });
    updateAttachments([...attachmentValues.current, ...items]);
    setError('');
    await Promise.all(
      files.map(async (file, index) => {
        const item = items[index];
        const controller = item.controller!;
        try {
          const body = new FormData();
          body.append('file', file);
          const artifact = await api<Artifact>('/api/uploads', {
            method: 'POST',
            body,
            signal: controller.signal,
          });
          if (mounted.current && !controller.signal.aborted)
            updateAttachments(
              attachmentValues.current.map((value) =>
                value.id === item.id ? { ...value, artifact, controller: undefined } : value,
              ),
            );
        } catch (cause) {
          if (mounted.current && !controller.signal.aborted) {
            removeAttachment(item);
            setError(errorMessage(cause));
          }
        } finally {
          uploads.current.delete(controller);
        }
      }),
    );
    if (mounted.current) {
      if (fileInput.current) fileInput.current.value = '';
      restoreFocus();
    }
  }
  async function submit() {
    if (
      !editor ||
      !ready ||
      sending ||
      sendLock.current ||
      attachmentValues.current.some((item) => !item.artifact)
    )
      return;
    const sentText = editor.getMarkdown().trim();
    const sentAttachments = attachmentValues.current;
    if (!sentText && !sentAttachments.length) return;
    sendLock.current = true;
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
      sendLock.current = false;
      if (result.sent) for (const item of sentAttachments) releasePreview(item);
      if (mounted.current && !editor.isDestroyed) {
        if (!result.sent) {
          if (result.restoreText) {
            const draft = editor.getMarkdown();
            editor.commands.setContent([sentText, draft].filter(Boolean).join('\n\n'), {
              contentType: 'markdown',
            });
          }
          updateAttachments([...sentAttachments, ...attachmentValues.current]);
        }
        restoreFocus();
      }
    }
  }
  actions.current = { submit: () => void submit(), upload: (files) => void upload(files) };
  const pendingUploads = attachments.filter((item) => !item.artifact).length;
  const images = attachments.flatMap((item): ImagePreview[] => {
    const url =
      item.previewUrl ||
      (item.artifact && ownedArtifactUrl(item.artifact.url) ? item.artifact.url : undefined);
    return attachmentKind(item.mimeType) && url
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
  });
  const previewLabel = images.every((image) => previewableImage(image.mimeType ?? 'image/png'))
    ? 'image'
    : 'attachment';
  return (
    <div className="composer-wrap">
      {error && <Notice>{error}</Notice>}
      {replyTo && (
        <div className="reply-context composer-reply">
          <CornerUpLeft size={15} />
          <div>
            <strong>Replying to {replyTo.role === 'assistant' ? 'Otto' : 'yourself'}</strong>
            <span>{replyTo.text || 'Attachment'}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={clearReply}
            aria-label="Cancel reply"
          >
            <X size={14} />
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
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        {(attachments.length > 0 || pendingUploads > 0) && (
          <div className="pending-attachments" aria-label="Message attachments">
            {attachments.map((item) => {
              const imageIndex = images.findIndex((image) => image.id === item.id);
              const image = images[imageIndex];
              return (
                <div
                  className={`pending-attachment${image ? ` is-preview${previewableImage(item.mimeType) ? ' is-image' : ''}` : ''}`}
                  key={item.id}
                >
                  {image ? (
                    <>
                      <button
                        type="button"
                        className="pending-image-preview"
                        aria-label={`Preview ${previewLabel} ${imageIndex + 1} of ${images.length}`}
                        onClick={(event) => {
                          previewTrigger.current = event.currentTarget;
                          setPreviewId(item.id);
                        }}
                      >
                        <AttachmentThumbnail image={image} />
                      </button>
                      {!item.artifact && (
                        <span className="pending-image-uploading" aria-hidden="true">
                          <LoaderCircle size={14} className="spin" />
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <FileText size={16} />
                      <span>{item.name}</span>
                    </>
                  )}
                  <button
                    type="button"
                    className="remove-attachment"
                    onClick={() => removeAttachment(item)}
                    aria-label={`Remove ${item.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {pendingUploads > 0 && (
              <span className="attachment-uploading" role="status">
                <LoaderCircle size={14} className="spin" />
                Uploading {pendingUploads === 1 ? 'file' : `${pendingUploads} files`}…
              </span>
            )}
          </div>
        )}
        <EditorContent editor={editor} />
        <span className="sr-only" id="composer-keyboard-hint">
          Enter to send. Shift plus Enter for a new line or list item.
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
              onChange={(event) => void upload(Array.from(event.target.files ?? []))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach files"
              title="Attach files or paste an image"
              onClick={() => fileInput.current?.click()}
              disabled={attachments.length >= 5}
            >
              <Paperclip size={18} />
            </Button>
          </div>
          <Button
            type="submit"
            size="icon"
            className="send-button"
            aria-label="Send message"
            disabled={
              !ready || sending || pendingUploads > 0 || (!text.trim() && !attachments.length)
            }
          >
            {sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={19} />}
          </Button>
        </div>
      </form>
      <ImageViewer
        images={images}
        allowLocalPreviews
        selectedId={previewId}
        onSelect={setPreviewId}
        onClose={() => setPreviewId(null)}
        restoreFocus={() =>
          previewTrigger.current?.isConnected ? previewTrigger.current.focus() : focus()
        }
      />
    </div>
  );
});
