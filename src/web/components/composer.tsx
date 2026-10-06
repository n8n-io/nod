import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { ArrowUp, Paperclip, X, FileText, LoaderCircle, CornerUpLeft, Square } from 'lucide-react';
import type { Artifact, Message } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { createComposerExtensions } from '../lib/composer-editor';
import { onPrepareDesktopUpdate } from '../lib/desktop';
import { Button, Notice } from './ui';
import {
  ImageViewer,
  AttachmentThumbnail,
  attachmentKind,
  localPreviewable,
  ownedArtifactUrl,
  previewableImage,
  restoreAttachmentFocus,
  type AttachmentTrigger,
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
  text: string;
  setText(value: string): void;
  replyTo: Pick<Message, 'id' | 'role' | 'text'> | null;
  clearReply(): void;
  onSend(text: string, attachments: Artifact[]): Promise<ComposerSendResult>;
  onStop?(): void;
  stopping?: boolean;
  canRestart?(): boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { ready, text, setText, replyTo, clearReply, onSend, onStop, stopping = false, canRestart },
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
  const previewTrigger = useRef<AttachmentTrigger | null>(null);
  const lastText = useRef(text);
  const sends = useRef(0);
  const pendingSends = useRef(0);
  const unsent = useRef<Array<{ sequence: number; text: string; attachments: DraftAttachment[] }>>(
    [],
  );
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
  useLayoutEffect(
    () =>
      onPrepareDesktopUpdate(
        () =>
          Boolean(editor && !editor.isDestroyed) &&
          !text.trim() &&
          !editor!.getMarkdown().trim() &&
          !attachmentValues.current.length &&
          !uploads.current.size &&
          !pendingSends.current &&
          !unsent.current.length &&
          !replyTo &&
          !document.querySelector('[role="dialog"], dialog[open]') &&
          (canRestart?.() ?? true),
      ),
    [editor, text, replyTo, canRestart],
  );
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
    if (files.length + attachmentValues.current.length > 20) {
      setError('Attach up to 20 files per message.');
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
      if (localPreviewable(file.type, file.name)) {
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
  function restoreUnsent() {
    const items = unsent.current.splice(0).sort((a, b) => a.sequence - b.sequence);
    if (!items.length || !editor || editor.isDestroyed || !mounted.current) return;
    editor.commands.setContent(
      [...items.map((item) => item.text), editor.getMarkdown()].filter(Boolean).join('\n\n'),
      { contentType: 'markdown' },
    );
    updateAttachments([...items.flatMap((item) => item.attachments), ...attachmentValues.current]);
    restoreFocus();
  }
  async function submit() {
    if (!editor || !ready || attachmentValues.current.some((item) => !item.artifact)) return;
    const sentText = editor.getMarkdown().trim();
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
  actions.current = { submit: () => void submit(), upload: (files) => void upload(files) };
  const pendingUploads = attachments.filter((item) => !item.artifact).length;
  const images = attachments.flatMap((item): ImagePreview[] => {
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
  });
  const previewLabel = images.every((image) =>
    previewableImage(image.mimeType ?? 'image/png', image.name),
  )
    ? 'image'
    : 'attachment';
  return (
    <div className="composer-wrap">
      {error && <Notice>{error}</Notice>}
      {replyTo && (
        <div className="reply-context composer-reply">
          <CornerUpLeft size={16} />
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
                  className={`pending-attachment${image ? ` is-preview${previewableImage(item.mimeType, item.name) ? ' is-image' : ''}` : ''}`}
                  key={item.id}
                >
                  {image ? (
                    <>
                      <button
                        type="button"
                        className="pending-image-preview"
                        aria-label={`Preview ${previewLabel} ${imageIndex + 1} of ${images.length}`}
                        onClick={(event) => {
                          previewTrigger.current = {
                            element: event.currentTarget,
                            keyboard: event.detail === 0,
                          };
                          setPreviewId(item.id);
                        }}
                      >
                        <AttachmentThumbnail image={image} />
                      </button>
                      {!item.artifact && (
                        <span className="pending-image-uploading" aria-hidden="true">
                          <LoaderCircle size={16} className="spin" />
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
                    <X size={16} />
                  </button>
                </div>
              );
            })}
            {pendingUploads > 0 && (
              <span className="attachment-uploading" role="status">
                <LoaderCircle size={16} className="spin" />
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
              disabled={attachments.length >= 20}
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
                aria-label="Stop Otto"
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
              <ArrowUp size={24} />
            </Button>
          </div>
        </div>
      </form>
      <ImageViewer
        images={images}
        allowLocalPreviews
        selectedId={previewId}
        onSelect={setPreviewId}
        onClose={() => setPreviewId(null)}
        restoreFocus={() => {
          if (!restoreAttachmentFocus(previewTrigger.current)) focus();
        }}
      />
    </div>
  );
});
