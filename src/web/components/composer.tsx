import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { ArrowUp, Paperclip, X, RotateCcw, CornerUpLeft, Square, Mic, LoaderCircle } from './icons';
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
import { readChatDraft, writeChatDraft } from '../lib/chat-draft';
import { artifactFromPreview } from './file-actions';
import { ownedArtifactUrl as validArtifact } from '../lib/attachment-url';
import { useArtifactDrawer } from './artifact-context';
import { usePageData } from '../hooks/use-page-data';
import { useVoiceRecorder } from '../hooks/use-voice-recorder';
import { VoiceRecorder, VoiceSetup } from './voice-recorder';

interface DraftAttachment {
  id: string;
  file?: File;
  state: 'checking' | 'queued' | 'uploading' | 'failed' | 'ready';
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
  upload(files: File[]): void;
}

export type ComposerSendResult =
  { sent: true } | { sent: false; restoreText: boolean; restoreRecording?: boolean };

interface ComposerProps {
  draftKey?: string;
  privateReply?: boolean;
  restoreReply?(reply: Pick<Message, 'id' | 'role' | 'text'> | null): void;
  ready: boolean;
  text: string;
  setText(value: string): void;
  replyTo: Pick<Message, 'id' | 'role' | 'text'> | null;
  clearReply(): void;
  onSend(text: string, attachments: Artifact[], recording?: File): Promise<ComposerSendResult>;
  onStop?(): void;
  stopping?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    ready,
    text,
    setText,
    replyTo,
    clearReply,
    onSend,
    onStop,
    stopping = false,
    draftKey,
    restoreReply,
    privateReply = false,
  },
  ref,
) {
  const [restored] = useState(() => (draftKey ? readChatDraft(draftKey) : null));
  const restoredOnce = useRef(false);
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    () =>
      restored?.attachments.map((artifact) => ({
        ...artifact,
        artifact,
        state: 'checking',
      })) ?? [],
  );
  const drawer = useArtifactDrawer();
  const {
    data: speech,
    error: speechError,
    refresh: refreshSpeech,
    refreshing: refreshingSpeech,
  } = usePageData<{
    transcription: boolean;
    transcriptionFormat?: 'wav';
    local?: { state: 'not_downloaded' | 'downloading' | 'ready' | 'failed'; progress?: number };
  }>('/api/speech');
  const recorder = useVoiceRecorder(draftKey, speech?.transcriptionFormat);
  const [showAudioSetup, setShowAudioSetup] = useState(false);
  const [preparingAudio, setPreparingAudio] = useState(false);
  const audioSetup = useRef<AbortController | null>(null);
  const [sendingAudio, setSendingAudio] = useState(false);
  const audioSend = useRef(false);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<DraftAttachment | null>(null);
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
  useImperativeHandle(ref, () => ({ focus, upload: (files) => upload(files, 'drop') }), [editor]);
  useEffect(() => {
    if (restoredOnce.current || !editor) return;
    restoredOnce.current = true;
    const saved = restored;
    attachmentValues.current = attachments;
    if (saved) {
      if (!text) setText(saved.text);
      if (!replyTo) restoreReply?.(saved.reply);
      if (saved.missing.length) setError(`Attach these files again: ${saved.missing.join(', ')}`);
      void (async () => {
        for (let start = 0; start < saved.attachments.length && mounted.current; start += 4)
          await Promise.all(
            saved.attachments
              .slice(start, start + 4)
              .filter((item) => attachmentValues.current.some((value) => value.id === item.id))
              .map(checkArtifact),
          );
      })();
    }
  }, [editor]);
  useEffect(() => {
    if (draftKey && restoredOnce.current)
      writeChatDraft(
        draftKey,
        {
          text,
          reply: replyTo,
          attachments: attachments.flatMap((item) => (item.artifact ? [item.artifact] : [])),
          missing: attachments.filter((item) => !item.artifact).map((item) => item.name),
        },
        privateReply,
      );
  }, [draftKey, text, replyTo, attachments, privateReply]);
  useEffect(() => {
    const receive = (event: Event) => {
      const item = (event as CustomEvent<ImagePreview>).detail;
      if (!item || !validArtifact(item.url)) return;
      const artifact = artifactFromPreview(item);
      if (
        attachmentValues.current.some(
          (value) => value.id === artifact.id || value.artifact?.id === artifact.id,
        )
      )
        return;
      updateAttachments([...attachmentValues.current, { ...artifact, artifact, state: 'ready' }]);
      focus();
    };
    window.addEventListener('nod:attach-artifact', receive);
    return () => window.removeEventListener('nod:attach-artifact', receive);
  }, [editor]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of uploads.current) controller.abort();
      uploads.current.clear();
      audioSetup.current?.abort();
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    };
  }, []);
  useEffect(() => {
    if (
      !showAudioSetup ||
      refreshingSpeech ||
      (!preparingAudio && speech?.local?.state !== 'downloading')
    )
      return;
    const timer = window.setTimeout(() => void refreshSpeech(), 1000);
    return () => window.clearTimeout(timer);
  }, [showAudioSetup, preparingAudio, speech?.local?.state, refreshSpeech, refreshingSpeech]);
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
  async function checkArtifact(item: Artifact) {
    updateAttachments(
      attachmentValues.current.map((value) =>
        value.id === item.id ? { ...value, state: 'checking', error: undefined } : value,
      ),
    );
    try {
      const artifact = await api<Artifact>(`${item.url}/metadata`);
      if (mounted.current)
        updateAttachments(
          attachmentValues.current.map((value) =>
            value.id === item.id ? { ...value, artifact, state: 'ready' } : value,
          ),
        );
    } catch (cause) {
      if (mounted.current)
        updateAttachments(
          attachmentValues.current.map((value) =>
            value.id === item.id
              ? { ...value, state: 'failed', error: errorMessage(cause) }
              : value,
          ),
        );
    }
  }
  function releasePreview(item: DraftAttachment) {
    if (item.previewUrl && previewUrls.current.delete(item.previewUrl))
      URL.revokeObjectURL(item.previewUrl);
  }
  function removeAttachment(item: DraftAttachment) {
    if (item.state === 'ready') setRemoved(item);
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
          if (!item.file) throw new Error('Choose this file again.');
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
    if (item.artifact && !item.file) {
      void checkArtifact(item.artifact);
      return;
    }
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
    const rejected = files.filter((file) => file.size > fileBytes);
    setError('');
    if (rejected.length) {
      setError(
        `${rejected.map((file) => file.name).join(', ')} must be ${fileBytes / 1024 / 1024} MB or smaller. The other files were kept.`,
      );
      files = files.filter((file) => file.size <= fileBytes);
      if (!files.length) {
        restoreFocus();
        return;
      }
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
  function cancelAudioSetup() {
    audioSetup.current?.abort();
    audioSetup.current = null;
    setPreparingAudio(false);
    setShowAudioSetup(false);
    focus();
  }
  async function prepareAudio() {
    if (audioSetup.current) return;
    const controller = new AbortController();
    audioSetup.current = controller;
    setPreparingAudio(true);
    setError('');
    try {
      await api('/api/speech/prepare', {
        method: 'POST',
        body: JSON.stringify({ locale: navigator.language }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) await refreshSpeech();
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (mounted.current && audioSetup.current === controller) {
        audioSetup.current = null;
        setPreparingAudio(false);
      }
    }
  }
  async function submit() {
    if (
      !editor ||
      !ready ||
      audioSend.current ||
      (recorder.phase !== 'idle' && recorder.phase !== 'preview') ||
      attachmentValues.current.some((item) => item.state !== 'ready')
    )
      return;
    if (recorder.needsPreparation) {
      audioSend.current = true;
      await recorder.prepare();
      audioSend.current = false;
      return;
    }
    const sentText = composerMarkdown(editor.state.doc).trim();
    const sentAttachments = attachmentValues.current;
    const sentRecording = recorder.recording?.file;
    if (!sentText && !sentAttachments.length && !sentRecording) return;
    if (sentRecording) {
      audioSend.current = true;
      setSendingAudio(true);
    }
    const sequence = ++sends.current;
    pendingSends.current++;
    setError('');
    setRemoved(null);
    if (draftKey) writeChatDraft(draftKey, null);
    editor.commands.clearContent();
    updateAttachments([]);
    focus();
    let result: ComposerSendResult = { sent: false, restoreText: true };
    try {
      result = await onSend(
        sentText,
        sentAttachments.map((item) => item.artifact!),
        sentRecording,
      );
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pendingSends.current--;
      if (sentRecording) {
        audioSend.current = false;
        if (mounted.current) {
          setSendingAudio(false);
          if (result.sent || result.restoreRecording === false) recorder.discard();
        }
      }
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
  useEffect(() => {
    const drop = (event: DragEvent) => {
      if (
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        !event.target.closest('.chat-page') ||
        event.target.closest('.artifact-drawer,.private-entry-panel,.browser-handoff')
      )
        return;
      if (event.dataTransfer?.files.length) {
        event.preventDefault();
        upload(Array.from(event.dataTransfer.files), 'drop');
      }
    };
    const over = (event: DragEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.chat-page') &&
        event.dataTransfer?.types.includes('Files')
      )
        event.preventDefault();
    };
    window.addEventListener('drop', drop);
    window.addEventListener('dragover', over);
    return () => {
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragover', over);
    };
  }, [editor]);
  const pendingUploads = attachments.filter((item) => item.state !== 'ready').length;
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
  const recordingActive = recorder.phase !== 'idle' && recorder.phase !== 'preview';
  const microphoneTitle = !recorder.supported
    ? 'This browser cannot record audio'
    : speech?.transcription === false && !speech.local
      ? 'Connect speech in Settings → Models'
      : speechError
        ? 'Check voice message availability'
        : !speech
          ? 'Checking voice message availability…'
          : 'Record an audio message';
  useEffect(() => {
    setDrafts(images);
    return () => setDrafts([]);
  }, [images, setDrafts]);
  return (
    <div className="composer-wrap">
      {error && <Notice>{error}</Notice>}
      {recorder.error && <Notice onDismiss={recorder.clearError}>{recorder.error}</Notice>}
      {removed && (
        <Notice
          kind="info"
          onDismiss={() => {
            setRemoved(null);
            focus();
          }}
        >
          Attachment removed.{' '}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!attachmentValues.current.some((item) => item.id === removed.id))
                updateAttachments([
                  ...attachmentValues.current,
                  { ...removed, previewUrl: undefined },
                ]);
              setRemoved(null);
              focus();
            }}
          >
            Undo
          </Button>
        </Notice>
      )}
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
          const internal = event.dataTransfer.getData('application/x-nod-artifact');
          if (internal) {
            event.preventDefault();
            event.stopPropagation();
            try {
              window.dispatchEvent(
                new CustomEvent('nod:attach-artifact', { detail: JSON.parse(internal) }),
              );
            } catch {}
            return;
          }
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          void upload(Array.from(event.dataTransfer.files), 'drop');
        }}
      >
        <VoiceRecorder
          recorder={recorder}
          sending={sendingAudio}
          onDiscard={() => {
            recorder.discard();
            focus();
          }}
        />
        {showAudioSetup && speech?.local && (
          <VoiceSetup
            ready={speech.transcription}
            preparing={preparingAudio || speech.local.state === 'downloading'}
            progress={speech.local.progress}
            failed={speech.local.state === 'failed'}
            onPrepare={() => void prepareAudio()}
            onCancel={cancelAudioSetup}
            onRecord={() => {
              setShowAudioSetup(false);
              void recorder.start();
            }}
          />
        )}
        {attachments.length > 0 && (
          <div
            className="pending-attachments composer-attachments"
            aria-label="Message attachments"
          >
            {attachments.map((item) => {
              const preview = images.some((image) => image.id === item.id);
              const uploading = item.state === 'uploading' || item.state === 'queued';
              const status =
                item.state === 'checking'
                  ? 'Checking…'
                  : item.state === 'uploading'
                    ? 'Uploading…'
                    : item.state === 'queued'
                      ? 'Waiting…'
                      : item.state === 'failed'
                        ? item.artifact
                          ? 'Check failed'
                          : 'Upload failed'
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
                      aria-label={`Retry ${item.artifact ? 'checking' : 'uploading'} ${item.name}`}
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
            {recorder.phase === 'idle' && !showAudioSetup && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="record-button"
                aria-label={microphoneTitle}
                title={microphoneTitle}
                disabled={
                  !ready ||
                  !recorder.supported ||
                  (!speech && !speechError) ||
                  (speech?.transcription === false && !speech.local)
                }
                onClick={() => {
                  setError('');
                  if (speechError) {
                    void refreshSpeech();
                    setError(
                      'Voice messages could not connect. Check your connection and try again.',
                    );
                  } else if (!speech?.transcription && speech?.local) setShowAudioSetup(true);
                  else void recorder.start();
                }}
              >
                <Mic size={18} />
              </Button>
            )}
            {onStop && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="stop-button"
                aria-label="Stop all work"
                title="Stop all work"
                disabled={stopping}
                onClick={onStop}
              >
                <Square size={16} fill="currentColor" />
              </Button>
            )}
            <Button
              type="submit"
              size={recorder.recording ? 'sm' : 'icon'}
              className={`send-button${recorder.recording ? ' send-audio-button' : ''}`}
              aria-label={
                sendingAudio
                  ? 'Sending audio'
                  : recorder.needsPreparation
                    ? 'Prepare audio message'
                    : recorder.recording
                      ? 'Send audio message'
                      : 'Send message'
              }
              disabled={
                !ready ||
                pendingUploads > 0 ||
                recordingActive ||
                sendingAudio ||
                (!text.trim() && !attachments.length && !recorder.recording)
              }
            >
              {sendingAudio ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}
              {recorder.recording &&
                (sendingAudio
                  ? 'Sending…'
                  : recorder.needsPreparation
                    ? 'Prepare audio'
                    : 'Send audio')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
});
