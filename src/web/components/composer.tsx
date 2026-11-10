import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import {
  ArrowUp,
  Paperclip,
  X,
  RotateCcw,
  CornerUpLeft,
  Square,
  Mic,
  LoaderCircle,
  CircleAlert,
} from './icons';
import type { Artifact, Message } from '../../shared/contracts';
import { fileBytes } from '../../shared/files';
import { api, errorMessage } from '../lib/api';
import { isEditingTarget, shortcutLabel } from '../lib/navigation';
import { Tooltip } from './tooltip';
import { captureAnalytics } from '../lib/analytics';
import { createComposerExtensions } from '../lib/composer-editor';
import {
  composerDisplayMarkdown,
  composerMarkdown,
  parseComposerMarkdown,
} from '../lib/composer-markdown';
import { EditorFormatting } from './editor-formatting';
import { Button, Notice } from './ui';
import { ownedArtifactUrl, type ImagePreview } from './attachment-images';
import { FileGlyph } from './attachment-glyph';
import { attachmentKind, fileSize, localPreviewable } from '../lib/attachment-kind';
import { readChatDraft, writeChatDraft } from '../lib/chat-draft';
import { artifactFromPreview, reuseFile } from './file-actions';
import { ownedArtifactUrl as validArtifact } from '../lib/attachment-url';
import { useArtifactDrawer } from './artifact-context';
import { usePageData } from '../hooks/use-page-data';
import { useVoiceRecorder } from '../hooks/use-voice-recorder';
import { MicrophonePicker, VoiceRecorder, VoiceSetup } from './voice-recorder';
import { MessageQuote } from './message';

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
  hasDraft(): boolean;
  prependText(value: string): boolean;
  upload(files: File[]): void;
}

export type ComposerSendResult =
  { sent: true } | { sent: false; restoreText: boolean; restoreRecording?: boolean };

interface ComposerProps {
  active?: boolean;
  draftKey?: string;
  privateReply?: boolean;
  restoreReply?(reply: Message['replyTo']): void;
  ready: boolean;
  busy?: boolean;
  text: string;
  setText(value: string): void;
  replyTo: Message['replyTo'];
  replyPreviewPending?: boolean;
  retryReplyPreview?(): void;
  clearReply(): void;
  onSend(
    text: string,
    attachments: Artifact[],
    recording?: File,
    displayText?: string,
  ): Promise<ComposerSendResult>;
  onStop?(): void;
  stopping?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    active = true,
    ready,
    busy = false,
    text,
    setText,
    replyTo,
    clearReply,
    onSend,
    onStop,
    stopping = false,
    draftKey,
    restoreReply,
    replyPreviewPending = false,
    retryReplyPreview,
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
    refresh: refreshSpeech,
    refreshing: refreshingSpeech,
  } = usePageData<{
    transcription: boolean;
    transcriptionFormat?: 'wav';
    local?: { state: 'not_downloaded' | 'downloading' | 'ready' | 'failed'; progress?: number };
    localInput?: {
      state: 'not_downloaded' | 'downloading' | 'ready' | 'failed';
      progress?: number;
    };
  }>('/api/speech');
  const recorder = useVoiceRecorder(draftKey, speech?.transcriptionFormat, active);
  const [showAudioSetup, setShowAudioSetup] = useState(false);
  const [preparingAudio, setPreparingAudio] = useState(false);
  const [audioSetupError, setAudioSetupError] = useState('');
  const heldMicrophoneClick = useRef(false);
  const audioSetup = useRef<AbortController | null>(null);
  const audioPreparation = useRef<Promise<{ transcriptionFormat?: 'wav' }> | null>(null);
  const audioActive = useRef(active);
  audioActive.current = active;
  const [sendingAudio, setSendingAudio] = useState(false);
  const recordingPress = useRef<{
    phase: 'pending' | 'recording';
    source: 'pointer' | 'keyboard';
  } | null>(null);
  const audioSend = useRef(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const attachmentValues = useRef<DraftAttachment[]>([]);
  const uploads = useRef(new Set<AbortController>());
  const renewal = useRef<AbortController | null>(null);
  const uploadQueue = useRef(Promise.resolve());
  const previewUrls = useRef(new Set<string>());
  const lastText = useRef(text);
  const restoringText = useRef(false);
  const sends = useRef(0);
  const pendingSends = useRef(0);
  const unsent = useRef<
    Array<{ sequence: number; content: JSONContent; attachments: DraftAttachment[] }>
  >([]);
  const actions = useRef({
    submit: () => {},
    upload: (_files: File[], _method: 'paste') => {},
  });
  const placeholder = busy ? 'Send another message to Nod…' : 'Message Nod…';
  const currentPlaceholder = useRef(placeholder);
  currentPlaceholder.current = placeholder;
  const extensions = useMemo(
    () =>
      createComposerExtensions({
        submit: () => actions.current.submit(),
        upload: (files) => actions.current.upload(files, 'paste'),
        placeholder: () => currentPlaceholder.current,
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
        'aria-label': 'Message Nod',
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
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);
  function focus() {
    if (editor && !editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: false });
  }
  function restoreFocus() {
    if (document.activeElement === document.body || form.current?.contains(document.activeElement))
      focus();
  }
  useImperativeHandle(
    ref,
    () => ({
      focus,
      hasDraft: () =>
        Boolean(
          !editor ||
          composerMarkdown(editor.state.doc).trim() ||
          attachmentValues.current.length ||
          recorder.phase !== 'idle' ||
          recorder.recording ||
          pendingSends.current ||
          unsent.current.length,
        ),
      prependText: (value) => {
        if (!editor || editor.isDestroyed) return false;
        const content = [
          ...(parseComposerMarkdown(value).content ?? []),
          ...(composerMarkdown(editor.state.doc) ? (editor.state.doc.toJSON().content ?? []) : []),
        ];
        return editor.commands.setContent({ type: 'doc', content });
      },
      upload: (files) => upload(files, 'drop'),
    }),
    [editor, recorder.phase, recorder.recording],
  );
  useEffect(() => {
    if (restoredOnce.current || !editor) return;
    restoredOnce.current = true;
    const saved = restored;
    attachmentValues.current = attachments;
    if (saved) {
      if (!text) {
        if (saved.content) {
          try {
            const document = editor.schema.nodeFromJSON(saved.content);
            if (composerMarkdown(document) === saved.text) {
              editor.commands.setContent(saved.content, { emitUpdate: false });
              lastText.current = saved.text;
              restoringText.current = true;
            }
          } catch {}
        }
        setText(saved.text);
      }
      if (!replyTo) restoreReply?.(saved.reply);
      if (saved.missing.length) setError(`Attach these files again: ${saved.missing.join(', ')}`);
      void renewAttachments(saved.attachments.map((item) => item.id));
    }
  }, [editor]);
  useEffect(() => {
    if (restoringText.current && !text) return;
    if (draftKey && restoredOnce.current) {
      let content: JSONContent | undefined;
      if (
        editor &&
        composerMarkdown(editor.state.doc) === text &&
        composerDisplayMarkdown(editor.state.doc) !== text
      )
        content = editor.state.doc.toJSON();
      writeChatDraft(
        draftKey,
        {
          text,
          reply: replyTo,
          attachments: attachments.flatMap((item) => (item.artifact ? [item.artifact] : [])),
          missing: attachments.filter((item) => !item.artifact).map((item) => item.name),
          content,
        },
        privateReply,
      );
    }
  }, [draftKey, text, replyTo, attachments, privateReply, editor]);
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
      updateAttachments([
        ...attachmentValues.current,
        { ...artifact, artifact, state: 'checking' },
      ]);
      void renewAttachments([artifact.id]);
      focus();
    };
    window.addEventListener('nod:attach-artifact', receive);
    return () => window.removeEventListener('nod:attach-artifact', receive);
  }, [editor]);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => void renewAttachments();
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const interval = window.setInterval(refresh, 5 * 60 * 1000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    refresh();
    return () => {
      mounted.current = false;
      renewal.current?.abort();
      renewal.current = null;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      for (const controller of uploads.current) controller.abort();
      uploads.current.clear();
      audioSetup.current?.abort();
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    };
  }, []);
  useEffect(() => {
    if (active) return;
    audioSetup.current?.abort();
    audioSetup.current = null;
    setPreparingAudio(false);
    setShowAudioSetup(false);
  }, [active]);
  useEffect(() => {
    if (active && recorder.phase === 'recording') sendButton.current?.focus();
  }, [active, recorder.phase]);
  useEffect(() => {
    if (
      !active ||
      refreshingSpeech ||
      (!preparingAudio && speech?.localInput?.state !== 'downloading')
    )
      return;
    const timer = window.setTimeout(() => void refreshSpeech(), 1000);
    return () => window.clearTimeout(timer);
  }, [active, preparingAudio, speech?.localInput?.state, refreshSpeech, refreshingSpeech]);
  useEffect(() => {
    if (speech?.transcription) {
      setAudioSetupError('');
      if (!preparingAudio) setShowAudioSetup(false);
    }
  }, [speech?.transcription, preparingAudio]);
  useEffect(() => {
    if (restoringText.current && !text) return;
    restoringText.current = false;
    if (editor && text !== lastText.current) {
      lastText.current = text;
      editor.commands.setContent(parseComposerMarkdown(text), { emitUpdate: false });
    }
  }, [editor, text]);
  function updateAttachments(values: DraftAttachment[]) {
    attachmentValues.current = values;
    setAttachments(values);
  }
  async function renewAttachments(checkIds: string[] = []) {
    if (!mounted.current || (renewal.current && !checkIds.length)) return;
    const checking = new Set(checkIds);
    const requested = new Map(
      attachmentValues.current.flatMap((item) =>
        item.artifact &&
        (item.state === 'ready' || item.state === 'checking' || checking.has(item.id))
          ? [[item.id, item.artifact.id] as const]
          : [],
      ),
    );
    if (!requested.size) return;
    renewal.current?.abort();
    const controller = new AbortController();
    renewal.current = controller;
    updateAttachments(
      attachmentValues.current.map((value) =>
        checking.has(value.id) ? { ...value, state: 'checking', error: undefined } : value,
      ),
    );
    const current = () =>
      mounted.current && !controller.signal.aborted && renewal.current === controller;
    const included = (item: DraftAttachment) =>
      requested.get(item.id) === item.artifact?.id &&
      (item.state === 'ready' || item.state === 'checking');
    try {
      const ids = [...new Set(requested.values())];
      const available = new Map<string, Artifact>();
      for (let start = 0; start < ids.length && current(); start += 100) {
        const artifacts = await api<Artifact[]>('/api/uploads/renew', {
          method: 'POST',
          body: JSON.stringify({ ids: ids.slice(start, start + 100) }),
          signal: controller.signal,
        });
        for (const artifact of artifacts) available.set(artifact.id, artifact);
      }
      if (current())
        updateAttachments(
          attachmentValues.current.map((value) => {
            if (!included(value)) return value;
            const artifact = available.get(value.artifact!.id);
            return artifact
              ? { ...value, artifact, state: 'ready', error: undefined }
              : { ...value, state: 'failed', error: 'An attachment is unavailable.' };
          }),
        );
    } catch (cause) {
      if (current())
        updateAttachments(
          attachmentValues.current.map((value) =>
            included(value) && value.state === 'checking'
              ? { ...value, state: 'failed', error: errorMessage(cause) }
              : value,
          ),
        );
    } finally {
      if (renewal.current === controller) renewal.current = null;
    }
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
      void renewAttachments([item.id]);
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
    captureAnalytics('attachment_added', {
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
    editor.commands.setContent({
      type: 'doc',
      content: [
        ...items.flatMap((item) => item.content.content ?? []),
        ...(composerMarkdown(editor.state.doc) ? (editor.state.doc.toJSON().content ?? []) : []),
      ],
    });
    updateAttachments([...items.flatMap((item) => item.attachments), ...attachmentValues.current]);
    void renewAttachments(
      items.flatMap((item) => item.attachments.map((attachment) => attachment.id)),
    );
    restoreFocus();
  }
  function cancelAudioSetup() {
    audioSetup.current?.abort();
    audioSetup.current = null;
    setPreparingAudio(false);
    setShowAudioSetup(false);
    setAudioSetupError('');
    void refreshSpeech();
  }
  function prepareAudio(): Promise<{ transcriptionFormat?: 'wav' }> {
    if (speech?.transcription) return Promise.resolve(speech);
    if (audioSetup.current && audioPreparation.current) return audioPreparation.current;
    const controller = new AbortController();
    audioSetup.current = controller;
    setPreparingAudio(true);
    setAudioSetupError('');
    const pending = (async () => {
      try {
        const result = await api<{ transcriptionFormat?: 'wav' }>('/api/speech/prepare', {
          method: 'POST',
          body: JSON.stringify({ inputOnly: true }),
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (!mounted.current || !audioActive.current)
          throw new DOMException('Cancelled', 'AbortError');
        void refreshSpeech();
        return result;
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted) {
          setAudioSetupError(errorMessage(cause));
          void refreshSpeech();
        }
        throw cause;
      } finally {
        if (audioSetup.current === controller) {
          audioSetup.current = null;
          audioPreparation.current = null;
          if (mounted.current) setPreparingAudio(false);
        }
      }
    })();
    audioPreparation.current = pending;
    return pending;
  }
  useEffect(() => {
    if (active && recorder.phase === 'recording') void prepareAudio().catch(() => {});
    else if (recorder.phase === 'idle') {
      audioSetup.current?.abort();
      audioSetup.current = null;
      setPreparingAudio(false);
    }
  }, [active, recorder.phase, speech?.transcription]);
  async function submit() {
    if (
      !editor ||
      !ready ||
      audioSend.current ||
      recorder.phase === 'requesting' ||
      recorder.phase === 'finishing' ||
      attachmentValues.current.some((item) => item.state !== 'ready')
    )
      return;
    const sentContent = editor.state.doc.toJSON();
    const serializedText = composerMarkdown(editor.state.doc);
    const sentText = serializedText.trim() ? serializedText : '';
    const renderedText = sentText ? composerDisplayMarkdown(editor.state.doc) : '';
    const displayText = renderedText === sentText ? undefined : renderedText;
    const sentAttachments = attachmentValues.current;
    const includesAudio = recorder.phase === 'recording' || Boolean(recorder.recording);
    if (!sentText && !sentAttachments.length && !includesAudio) return;
    if (includesAudio) audioSend.current = true;
    const sequence = ++sends.current;
    pendingSends.current++;
    setError('');
    if (draftKey) writeChatDraft(draftKey, null);
    editor.commands.clearContent();
    updateAttachments([]);
    focus();
    let result: ComposerSendResult = { sent: false, restoreText: true };
    try {
      let sentRecording: File | undefined;
      if (includesAudio) {
        const captured = await recorder.finish();
        if (!captured || !mounted.current || editor.isDestroyed) return;
        setSendingAudio(true);
        const prepared = await prepareAudio();
        if (!mounted.current || !audioActive.current || editor.isDestroyed) return;
        const file = await recorder.finish(prepared.transcriptionFormat);
        if (!file || !mounted.current || editor.isDestroyed) return;
        sentRecording = file;
      }
      result = await onSend(
        sentText,
        sentAttachments.map((item) => item.artifact!),
        sentRecording,
        displayText,
      );
    } catch (cause) {
      if (mounted.current && !(cause instanceof DOMException && cause.name === 'AbortError'))
        setError(errorMessage(cause));
    } finally {
      pendingSends.current--;
      if (includesAudio) {
        audioSend.current = false;
        if (mounted.current) {
          setSendingAudio(false);
          if (result.sent || result.restoreRecording === false) recorder.discard();
        }
      }
      if (result.sent || !result.restoreText)
        for (const item of sentAttachments) releasePreview(item);
      else {
        unsent.current.push({ sequence, content: sentContent, attachments: sentAttachments });
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
  const hasRecording = recorder.phase !== 'idle';
  const showStop = Boolean(onStop && !text.trim() && !attachments.length && !hasRecording);
  function releaseRecording() {
    const press = recordingPress.current;
    recordingPress.current = null;
    if (press?.phase === 'pending') recorder.discard();
    else if (press?.phase === 'recording') recorder.stop();
  }
  const preparingSpeech =
    !speech?.transcription && (preparingAudio || speech?.localInput?.state === 'downloading');
  const audioFailure = recorder.error;
  const canRecord = !recorder.error;
  async function startRecording(source?: 'pointer' | 'keyboard') {
    setError('');
    if (!canRecord) {
      setShowAudioSetup(true);
      return;
    }
    const press = source ? { phase: 'pending' as const, source } : null;
    recordingPress.current = press;
    await recorder.start();
    if (press && recordingPress.current === press)
      recordingPress.current = { ...press, phase: 'recording' };
  }
  function activateMicrophone(source?: 'pointer' | 'keyboard') {
    if (recorder.phase === 'recording') recorder.stop();
    else void startRecording(source);
  }
  useEffect(() => {
    const release = () => releaseRecording();
    const pointer = () => {
      if (recordingPress.current?.source === 'pointer') release();
    };
    const key = (event: KeyboardEvent) => {
      if (
        recordingPress.current?.source === 'keyboard' &&
        (event.key === ' ' || event.key === 'Enter')
      )
        release();
    };
    window.addEventListener('pointerup', pointer);
    window.addEventListener('pointercancel', pointer);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', pointer);
      window.removeEventListener('pointercancel', pointer);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', release);
    };
  }, []);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !active ||
        !ready ||
        !recorder.supported ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.shiftKey ||
        !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
        event.key.toLowerCase() !== 'd' ||
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],dialog[open]',
        )
      )
        return;
      const chat = form.current?.closest('.chat-page');
      const targets = [
        event.target,
        document.activeElement,
        ...event.composedPath().filter(isEditingTarget),
      ];
      if (
        !chat ||
        targets.some(
          (target) =>
            target instanceof Element &&
            target !== document.body &&
            target !== document.documentElement &&
            (!chat.contains(target) ||
              target.closest('.artifact-drawer,.private-entry-panel,.browser-handoff') ||
              (isEditingTarget(target) && !editor?.view.dom.contains(target))),
        )
      )
        return;
      event.preventDefault();
      if (event.repeat || audioSend.current || sendingAudio) return;
      if (recorder.phase === 'recording') recorder.stop();
      else if (recorder.phase === 'idle') void startRecording();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, ready, recorder.supported, recorder.phase, sendingAudio, canRecord, editor, mac]);
  const recordingPending = recorder.phase === 'requesting' || recorder.phase === 'finishing';
  const microphoneDisabled =
    !active || !ready || !recorder.supported || recordingPending || sendingAudio;
  const audioProgress =
    speech?.localInput?.progress === undefined
      ? undefined
      : Math.max(0, Math.min(100, Math.round(speech.localInput.progress)));
  const microphoneLabel = !recorder.supported
    ? 'This browser cannot record audio'
    : audioFailure
      ? 'Audio needs attention'
      : recorder.phase === 'recording'
        ? 'Stop and preview recording'
        : recorder.phase === 'preview'
          ? 'Record again'
          : recorder.phase === 'requesting'
            ? 'Waiting for microphone'
            : recorder.phase === 'finishing'
              ? 'Preparing recording'
              : 'Record an audio message';
  const microphoneTitle =
    audioFailure ||
    (hasRecording
      ? microphoneLabel
      : canRecord && !hasRecording
        ? 'Press and hold to record\nRight-click for microphone settings'
        : `${microphoneLabel}\nRight-click for microphone settings`);
  function retryAudio() {
    recorder.clearError();
    setShowAudioSetup(false);
    void recorder.start();
  }
  useEffect(() => {
    setDrafts(images);
    return () => setDrafts([]);
  }, [images, setDrafts]);
  return (
    <div className="composer-wrap">
      {(error || audioSetupError) && <Notice>{error || audioSetupError}</Notice>}
      {replyTo && (
        <div className="reply-context composer-reply">
          <CornerUpLeft size={16} />
          {replyPreviewPending ? (
            <span role="status">Checking reply availability…</span>
          ) : retryReplyPreview ? (
            <>
              <span role="status">Couldn’t check this reply.</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={retryReplyPreview}
                aria-label="Retry reply availability"
              >
                Try again
              </Button>
            </>
          ) : (
            <MessageQuote message={replyTo} composing />
          )}
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
        className={`composer${hasRecording ? ' has-recording' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDownCapture={(event) => {
          if (
            !active ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.shiftKey ||
            !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
            event.key.toLowerCase() !== 'u'
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (!hasRecording && !event.repeat) fileInput.current?.click();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented && hasRecording && !sendingAudio) {
            event.preventDefault();
            recorder.discard();
            focus();
          }
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
              const item = JSON.parse(internal);
              if (item && validArtifact(item.url)) reuseFile(item, 'composer');
            } catch {}
            return;
          }
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
                  <Tooltip content={`${item.name} · ${item.size.toLocaleString()} bytes`}>
                    <button
                      type="button"
                      className="composer-file-open"
                      disabled={!preview}
                      aria-label={preview ? `Open ${item.name}` : item.name}
                      aria-current={drawer.selectedId === item.id || undefined}
                      aria-describedby={`attachment-status-${item.id}`}
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
                      <Tooltip content={item.error}>
                        <span
                          className="composer-file-status"
                          id={`attachment-status-${item.id}`}
                          role="status"
                        >
                          {status}
                          {item.error && <span className="sr-only">: {item.error}</span>}
                        </span>
                      </Tooltip>
                    </button>
                  </Tooltip>
                  {item.state === 'failed' && (
                    <Tooltip content={item.error}>
                      <button
                        type="button"
                        className="composer-file-retry"
                        onClick={() => retryAttachment(item)}
                        aria-label={`Retry ${item.artifact ? 'checking' : 'uploading'} ${item.name}`}
                      >
                        <RotateCcw size={12} />
                        Retry
                      </button>
                    </Tooltip>
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
        <EditorFormatting editor={editor} underlineShortcut={false} />
        <span className="sr-only" id="composer-keyboard-hint">
          Enter to send. Shift or Alt plus Enter for a new line or list item.
        </span>
        <div className="composer-tools">
          <div className="composer-left">
            {active && hasRecording && (
              <VoiceRecorder
                recorder={recorder}
                sending={sendingAudio}
                preparing={sendingAudio && preparingAudio}
                progress={audioProgress}
                onCancel={cancelAudioSetup}
                onDiscard={() => {
                  cancelAudioSetup();
                  recorder.discard();
                  focus();
                }}
              />
            )}
            <input
              ref={fileInput}
              type="file"
              tabIndex={-1}
              multiple
              className="sr-only"
              aria-label="Choose files"
              onChange={(event) => void upload(Array.from(event.target.files ?? []), 'picker')}
            />
          </div>
          <div className="composer-right">
            {!hasRecording && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach files"
                title="Attach files or paste an image"
                shortcut={shortcutLabel('u', mac)}
                aria-keyshortcuts={mac ? 'Meta+U' : 'Control+U'}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={16} />
              </Button>
            )}
            <MicrophonePicker
              recorder={recorder}
              disabled={!active || !ready || !recorder.supported || hasRecording}
              triggerDisabled={microphoneDisabled}
              hint={microphoneTitle}
              shortcut={shortcutLabel('d', mac)}
              setupOpen={showAudioSetup}
              onSetupOpenChange={setShowAudioSetup}
              setup={<VoiceSetup error={recorder.error} onRetry={retryAudio} />}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`record-button${recorder.phase === 'recording' ? ' is-recording' : ''}${audioFailure ? ' has-error' : ''}`}
                aria-label={microphoneLabel}
                aria-description={microphoneTitle}
                aria-haspopup={canRecord ? 'menu' : 'dialog'}
                aria-expanded={showAudioSetup || undefined}
                aria-keyshortcuts={`${mac ? 'Meta+D' : 'Control+D'} Shift+F10 Alt+ArrowDown`}
                disabled={microphoneDisabled}
                onPointerDown={(event) => {
                  heldMicrophoneClick.current = false;
                  if (
                    event.button !== 0 ||
                    event.ctrlKey ||
                    !canRecord ||
                    recorder.phase === 'recording'
                  )
                    return;
                  heldMicrophoneClick.current = true;
                  void startRecording('pointer');
                }}
                onKeyDown={(event) => {
                  if (
                    !event.repeat &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    (event.key === ' ' || event.key === 'Enter')
                  ) {
                    event.preventDefault();
                    activateMicrophone('keyboard');
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
                }}
                onClick={(event) => {
                  if (event.detail && heldMicrophoneClick.current) {
                    heldMicrophoneClick.current = false;
                    return;
                  }
                  activateMicrophone();
                }}
              >
                {audioFailure ? (
                  <CircleAlert size={18} />
                ) : recorder.phase === 'recording' ? (
                  <Square size={14} solid />
                ) : recordingPending || (preparingSpeech && audioProgress === undefined) ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <Mic size={18} />
                )}
                {preparingSpeech && audioProgress !== undefined && (
                  <svg className="record-button-progress" viewBox="0 0 32 32" aria-hidden="true">
                    <circle className="record-button-progress-track" cx="16" cy="16" r="14" />
                    <circle
                      cx="16"
                      cy="16"
                      r="14"
                      pathLength="100"
                      strokeDasharray={`${audioProgress} 100`}
                    />
                  </svg>
                )}
              </Button>
              <span className="sr-only" role="status">
                {preparingSpeech
                  ? `Preparing audio messages${audioProgress === undefined ? '' : ` · ${audioProgress}%`}`
                  : microphoneLabel}
              </span>
            </MicrophonePicker>
            <Button
              ref={sendButton}
              type={showStop ? 'button' : 'submit'}
              size="icon"
              className={`send-button${hasRecording ? ' send-audio-button' : ''}`}
              onClick={showStop ? onStop : undefined}
              title={showStop ? 'Stop Nod' : undefined}
              aria-label={
                showStop
                  ? 'Stop all work'
                  : sendingAudio
                    ? 'Sending audio'
                    : hasRecording
                      ? 'Send audio message'
                      : 'Send message'
              }
              disabled={
                showStop
                  ? stopping
                  : !ready ||
                    pendingUploads > 0 ||
                    recordingPending ||
                    sendingAudio ||
                    (!text.trim() && !attachments.length && !hasRecording)
              }
            >
              {showStop ? (
                <Square size={14} solid />
              ) : sendingAudio ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <ArrowUp size={18} />
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
});
